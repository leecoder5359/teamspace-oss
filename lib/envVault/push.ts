import { prisma } from "@/lib/prisma";
import { sendApproval } from "@/lib/approvals";
import { Prisma } from "@/app/generated/prisma/client";
import { openValue, sealValue, valueDigest, varAad } from "./crypto";
import {
  checkEnv, checkKey, digestMap, EnvVaultError, logAccess, requireProject, TARGET_SELECT, toTargetRow,
  IMPORT_TTL_MS, MAX_IMPORT_VARS, type EnvTargetRow, type Meta,
} from "./service";
import { DriftInputError, groupDrift, validateDriftResults, type DriftResults } from "./drift";
import { accountSummary, KIND_LABEL, parseTarget, TargetConfigError, targetSummary, type TargetKind } from "./targets";
import type { Ctx } from "@/lib/workspace";

/* =====================================================================
   env 금고 P2 — push 대상(EnvTarget) 관리와 push 흐름.

   push 흐름(P1 import 와 같은 '사람 확인 = 고위험 승인 클릭' 패턴)
   1. requestPush : CLI(에이전트 토큰)가 요청 → EnvOp(kind push) + 고위험 승인 카드. 값은 아직 안 나간다.
                    요청 시점의 키별 version 을 봉인해 둔다(승인 뒤 값이 바뀌면 받지 못하게).
   2. claimPush   : 사람이 승인했고 30분 안·한 번도 안 받아 갔을 때만, **요청한 그 토큰**에게 값을 1회 준다.
                    이때 값의 HMAC 지문을 op 에 봉인해 둔다(결과 기록용).
   3. reportPush  : CLI 가 반영 결과(키 이름만)를 알려 오면, 서버가 2에서 봉인한 지문으로
                    대상의 lastPushed 를 갱신한다. 클라이언트가 보낸 해시·값은 받지 않는다.
   서버는 클라우드 권한을 갖지 않는다 — 실제 반영은 CLI 가 로컬 로그인으로 한다.
   ===================================================================== */

type Actor = Pick<Ctx, "workspaceId" | "userId" | "actor">;
export const PUSH_TTL_MS = IMPORT_TTL_MS;

function wrapConfig<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof TargetConfigError) throw new EnvVaultError(400, e.message);
    throw e;
  }
}

async function findTarget(ctx: Actor, id: string) {
  const t = await prisma.envTarget.findFirst({ where: { id, workspaceId: ctx.workspaceId }, select: { ...TARGET_SELECT, identity: true } });
  if (!t) throw new EnvVaultError(404, "대상을 찾을 수 없습니다.");
  return t;
}

const isUnique = (e: unknown) => (e as { code?: unknown } | null)?.code === "P2002";
const DUP_MSG = "같은 프로젝트·환경에 같은 대상이 이미 있습니다.";

// ── 대상 CRUD ─────────────────────────────────────────────────────────────
export async function listTargets(ctx: Actor, q: { projectId?: string | null; env?: string | null; id?: string | null }): Promise<EnvTargetRow[]> {
  const projectId = q.projectId ? (await requireProject(ctx.workspaceId, q.projectId)).id : null;
  const env = q.env ? checkEnv(q.env) : null;
  const rows = await prisma.envTarget.findMany({
    where: { workspaceId: ctx.workspaceId, ...(projectId ? { projectId } : {}), ...(env ? { env } : {}), ...(q.id ? { id: q.id } : {}) },
    orderBy: [{ env: "asc" }, { kind: "asc" }, { createdAt: "asc" }],
    select: TARGET_SELECT,
  });
  return rows.map(toTargetRow);
}

export async function createTarget(
  ctx: Actor,
  input: { projectId: unknown; env: unknown; kind: unknown; config: unknown; account?: unknown },
  meta: Meta,
): Promise<EnvTargetRow> {
  const project = await requireProject(ctx.workspaceId, input.projectId);
  const env = checkEnv(input.env);
  const spec = wrapConfig(() => parseTarget(input.kind, input.config, input.account));
  try {
    const t = await prisma.envTarget.create({
      data: {
        workspaceId: ctx.workspaceId, projectId: project.id, env, kind: spec.kind, identity: spec.identity,
        config: spec.config as Prisma.InputJsonValue, account: spec.account as Prisma.InputJsonValue, createdById: ctx.userId,
      },
      select: TARGET_SELECT,
    });
    await logAccess(ctx, meta, { action: "target_add", projectId: project.id, env, targetId: t.id });
    return toTargetRow(t);
  } catch (e) {
    if (isUnique(e)) throw new EnvVaultError(409, DUP_MSG);
    throw e;
  }
}

/** config·account 교체(kind·env 는 바꾸지 않는다). 가리키는 곳이 바뀌면 마지막 반영 기록을 지운다. */
export async function updateTarget(ctx: Actor, id: string, input: { config?: unknown; account?: unknown }, meta: Meta): Promise<EnvTargetRow> {
  const t = await findTarget(ctx, id);
  if (input.config === undefined && input.account === undefined) throw new EnvVaultError(400, "바꿀 config 또는 account 가 필요합니다.");
  const spec = wrapConfig(() => parseTarget(t.kind, input.config ?? t.config, input.account ?? t.account));
  const moved = spec.identity !== t.identity;
  try {
    const u = await prisma.envTarget.update({
      where: { id: t.id },
      data: {
        identity: spec.identity, config: spec.config as Prisma.InputJsonValue, account: spec.account as Prisma.InputJsonValue,
        ...(moved ? { lastPushed: Prisma.DbNull, lastPushedAt: null, lastDrift: Prisma.DbNull, lastDriftAt: null } : {}),
      },
      select: TARGET_SELECT,
    });
    await logAccess(ctx, meta, { action: "target_update", projectId: t.projectId, env: t.env, targetId: t.id });
    return toTargetRow(u);
  } catch (e) {
    if (isUnique(e)) throw new EnvVaultError(409, DUP_MSG);
    throw e;
  }
}

export async function deleteTarget(ctx: Actor, id: string, meta: Meta): Promise<void> {
  const t = await findTarget(ctx, id);
  await prisma.envTarget.delete({ where: { id: t.id } }); // 대기 중인 push 작업도 함께 지워진다(cascade)
  await logAccess(ctx, meta, { action: "target_delete", projectId: t.projectId, env: t.env, targetId: t.id });
}

// ── push: 요청 → 받기(1회) → 결과 ─────────────────────────────────────────
function parseKeys(keys: unknown): string[] | null {
  if (keys === undefined || keys === null) return null;
  if (!Array.isArray(keys) || keys.length === 0) throw new EnvVaultError(400, "keys 는 1개 이상의 키 이름 배열이어야 합니다.");
  if (keys.length > MAX_IMPORT_VARS) throw new EnvVaultError(400, `한 번에 ${MAX_IMPORT_VARS}개까지만 보낼 수 있습니다.`);
  const out = [...new Set(keys.map(checkKey))];
  return out.sort();
}

export function pushCardBody(
  t: { kind: string; env: string; config: unknown; account: unknown },
  projectName: string,
  keys: string[],
): string {
  // 사람이 승인 전에 '값이 정확히 어디로 가는지' 보도록 config 를 필드별로 적는다(비밀 없음 — 경로·이름·계정)
  const c = (t.config ?? {}) as Record<string, string | undefined>;
  const where: string[] =
    t.kind === "dotenv" ? [`• 파일: ${c.path ?? "-"}`]
    : t.kind === "ssm" ? [`• SSM 경로: ${c.prefix ?? "-"}/<KEY> (SecureString)`, `• 리전: ${c.region ?? "기본값"} · 프로필: ${c.profile ?? "기본값"}`]
    : t.kind === "vercel" ? [`• Vercel 프로젝트: ${c.project ?? "-"} · 환경: ${c.target ?? "-"}`, `• scope: ${c.scope ?? "기본값"}${c.globalDir ? ` · -Q ${c.globalDir}` : ""}`]
    : t.kind === "gha" ? [`• GitHub 저장소: ${c.repo ?? "-"} · environment: ${c.environment ?? "(저장소 secret)"}`]
    : [`• ${targetSummary(t.kind, t.config)}`];
  return [
    `*프로젝트·환경*: ${projectName} / ${t.env}`,
    `*반영 대상*: ${KIND_LABEL[t.kind as TargetKind] ?? t.kind}`,
    ...where,
    `*기대 계정*: ${accountSummary(t.kind, t.account)} (CLI 가 반영 직전 로그인 계정과 대조)`,
    `*키 ${keys.length}개*: ${keys.join(", ")}`,
    "값은 카드에 싣지 않습니다. 승인하면 요청한 CLI 가 30분 안에 한 번 받아 반영합니다.",
  ].join("\n");
}

export async function requestPush(
  ctx: Actor,
  targetId: string,
  input: { keys?: unknown; channel?: unknown },
  meta: Meta,
): Promise<{ opId: string; approvalId: string; sent: boolean; error?: string; keys: string[]; expiresAt: Date }> {
  const t = await findTarget(ctx, targetId);
  const project = await requireProject(ctx.workspaceId, t.projectId);
  const want = parseKeys(input.keys);
  const rows = await prisma.envVar.findMany({
    where: { workspaceId: ctx.workspaceId, projectId: t.projectId, env: t.env, ...(want ? { key: { in: want } } : {}) },
    orderBy: { key: "asc" },
    select: { key: true, version: true },
  });
  if (want) {
    const have = new Set(rows.map((r) => r.key));
    const missing = want.filter((k) => !have.has(k));
    if (missing.length) throw new EnvVaultError(400, `금고에 없는 키: ${missing.join(", ")}`);
  }
  if (rows.length === 0) throw new EnvVaultError(400, "보낼 키가 없습니다(이 환경에 저장된 키가 없음).");
  const keys = rows.map((r) => r.key);
  const versions = Object.fromEntries(rows.map((r) => [r.key, r.version]));
  const expiresAt = new Date(Date.now() + PUSH_TTL_MS);

  const op = await prisma.$transaction(async (tx) => {
    const created = await tx.envOp.create({
      data: {
        workspaceId: ctx.workspaceId, projectId: t.projectId, env: t.env, kind: "push", mode: "push",
        targetId: t.id, keys, createdById: ctx.userId, expiresAt,
      },
      select: { id: true },
    });
    await tx.envOp.update({ where: { id: created.id }, data: { sealedPayload: sealValue(JSON.stringify({ versions }), `op:${created.id}`) } });
    return created;
  });

  const channel = typeof input.channel === "string" && input.channel.trim() ? input.channel.trim() : undefined;
  const ap = await sendApproval(ctx.workspaceId, {
    title: `env push: ${project.name}/${t.env} → ${KIND_LABEL[t.kind as TargetKind] ?? t.kind} ${keys.length}개 키`,
    body: pushCardBody(t, project.name, keys),
    channel,
    kind: "deploy",
    highRisk: true,
    createdBy: ctx.userId,
    projectId: project.id,
  });
  await prisma.envOp.update({ where: { id: op.id }, data: { approvalId: ap.id } });
  await logAccess(ctx, meta, { action: "push_request", projectId: t.projectId, env: t.env, keys, targetId: t.id });
  return { opId: op.id, approvalId: ap.id, sent: ap.sent, ...(ap.error ? { error: ap.error } : {}), keys, expiresAt };
}

async function findPushOp(ctx: Actor, opId: string) {
  const op = await prisma.envOp.findFirst({ where: { id: opId, workspaceId: ctx.workspaceId, kind: "push" } });
  if (!op) throw new EnvVaultError(404, "push 작업을 찾을 수 없습니다.");
  // 값은 요청한 그 토큰(사용자)에게만 — 다른 에이전트가 승인된 작업을 가로채지 못하게
  if (op.createdById !== ctx.userId) throw new EnvVaultError(403, "이 push 작업을 요청한 쪽만 받을 수 있습니다.");
  return op;
}

export async function claimPush(
  ctx: Actor,
  opId: string,
  meta: Meta,
): Promise<{ targetId: string; vars: { key: string; value: string }[] }> {
  const op = await findPushOp(ctx, opId);
  if (op.status === "claimed" || op.status === "done" || op.status === "partial" || op.status === "failed") {
    throw new EnvVaultError(409, "이미 받아 간 작업입니다. 다시 반영하려면 새로 요청하세요.");
  }
  if (op.status !== "pending") throw new EnvVaultError(409, `이미 종료된 작업입니다(${op.status}).`);
  if (op.expiresAt.getTime() < Date.now()) {
    await prisma.envOp.update({ where: { id: op.id }, data: { status: "expired", sealedPayload: null } });
    throw new EnvVaultError(410, "승인 유효 시간(30분)이 지났습니다. 다시 요청하세요.");
  }
  const approval = op.approvalId
    ? await prisma.approval.findFirst({ where: { id: op.approvalId, workspaceId: ctx.workspaceId }, select: { status: true, highRisk: true } })
    : null;
  if (!approval || !approval.highRisk) throw new EnvVaultError(409, "연결된 고위험 승인이 없습니다.");
  if (approval.status === "rejected") {
    await prisma.envOp.update({ where: { id: op.id }, data: { status: "rejected", sealedPayload: null } });
    throw new EnvVaultError(409, "승인이 거부되었습니다.");
  }
  if (approval.status !== "approved") throw new EnvVaultError(409, `아직 승인되지 않았습니다(현재: ${approval.status}).`);
  if (!op.sealedPayload || !op.targetId) throw new EnvVaultError(409, "받을 내용이 없습니다.");
  const { versions } = JSON.parse(openValue(op.sealedPayload, `op:${op.id}`)) as { versions: Record<string, number> };

  const r = await prisma.$transaction(async (tx) => {
    // 선점: pending 인 것만 한 번(동시 claim 경합 방지)
    const claimed = await tx.envOp.updateMany({ where: { id: op.id, status: "pending" }, data: { status: "claimed", claimedAt: new Date() } });
    if (claimed.count !== 1) throw new EnvVaultError(409, "이미 받아 간 작업입니다.");
    const rows = await tx.envVar.findMany({
      where: { workspaceId: ctx.workspaceId, projectId: op.projectId, env: op.env, key: { in: op.keys } },
      orderBy: { key: "asc" },
      select: { key: true, version: true, sealed: true },
    });
    const stale = rows.length !== op.keys.length || rows.some((x) => versions[x.key] !== x.version);
    if (stale) {
      await tx.envOp.update({ where: { id: op.id }, data: { status: "expired", sealedPayload: null } });
      return { stale: true as const };
    }
    const vars = rows.map((x) => ({ key: x.key, value: openValue(x.sealed, varAad(ctx.workspaceId, op.projectId, op.env, x.key)) }));
    const digests = Object.fromEntries(vars.map((v) => [v.key, valueDigest(v.value)]));
    await tx.envOp.update({ where: { id: op.id }, data: { sealedPayload: sealValue(JSON.stringify({ digests }), `op:${op.id}`) } });
    return { stale: false as const, vars };
  });
  if (r.stale) throw new EnvVaultError(409, "요청한 뒤 금고 값이 바뀌었거나 키가 지워졌습니다. 다시 요청하세요.");
  await logAccess(ctx, meta, { action: "push", projectId: op.projectId, env: op.env, keys: op.keys, targetId: op.targetId });
  return { targetId: op.targetId, vars: r.vars };
}

function parseResult(input: { pushed?: unknown; failed?: unknown }, allowed: Set<string>): { pushed: string[]; failed: string[] } {
  const pushedIn = input.pushed ?? [];
  const failedIn = input.failed ?? [];
  if (!Array.isArray(pushedIn) || !Array.isArray(failedIn)) throw new EnvVaultError(400, "pushed·failed 는 배열이어야 합니다.");
  const pushed = pushedIn.map(checkKey);
  // failed 의 error 문구는 저장하지 않는다(값이 섞였을 수 있다) — 키 이름만 쓴다
  const failed = failedIn.map((f) => checkKey(typeof f === "string" ? f : (f as { key?: unknown } | null)?.key));
  const all = [...pushed, ...failed];
  if (new Set(all).size !== all.length) throw new EnvVaultError(400, "pushed·failed 에 같은 키가 두 번 있습니다.");
  const unknown = all.filter((k) => !allowed.has(k));
  if (unknown.length) throw new EnvVaultError(400, `이 작업에 없던 키: ${unknown.join(", ")}`);
  return { pushed: [...pushed].sort(), failed: [...failed].sort() };
}

export async function reportPush(
  ctx: Actor,
  opId: string,
  input: { pushed?: unknown; failed?: unknown },
  meta: Meta,
): Promise<{ status: "done" | "partial" | "failed"; pushed: string[]; failed: string[] }> {
  const op = await findPushOp(ctx, opId);
  if (op.status !== "claimed") throw new EnvVaultError(409, op.status === "pending" ? "아직 값을 받지 않은 작업입니다." : `이미 결과가 기록되었거나 종료된 작업입니다(${op.status}).`);
  const { pushed, failed } = parseResult(input, new Set(op.keys));
  if (!op.sealedPayload || !op.targetId) throw new EnvVaultError(409, "결과를 기록할 수 없습니다.");
  const { digests } = JSON.parse(openValue(op.sealedPayload, `op:${op.id}`)) as { digests: Record<string, string> };
  const status = pushed.length === 0 ? "failed" : pushed.length === op.keys.length ? "done" : "partial";
  const targetId = op.targetId;

  await prisma.$transaction(async (tx) => {
    const done = await tx.envOp.updateMany({ where: { id: op.id, status: "claimed" }, data: { status, appliedAt: new Date(), sealedPayload: null } });
    if (done.count !== 1) throw new EnvVaultError(409, "이미 결과가 기록된 작업입니다.");
    if (pushed.length === 0) return;
    const t = await tx.envTarget.findUnique({ where: { id: targetId }, select: { lastPushed: true } });
    if (!t) return; // 그새 대상이 지워졌다(cascade 로 op 도 지워지므로 사실상 오지 않는다)
    const next = { ...digestMap(t.lastPushed), ...Object.fromEntries(pushed.map((k) => [k, digests[k]])) };
    await tx.envTarget.update({ where: { id: targetId }, data: { lastPushed: next, lastPushedAt: new Date() } });
  });
  await logAccess(ctx, meta, { action: "push_result", projectId: op.projectId, env: op.env, keys: pushed, targetId });
  return { status, pushed, failed };
}

// ── 드리프트 점검 결과 기록 (P3a) ─────────────────────────────────────────
/**
 * CLI 가 원격과 비교한 결과(키 → 상태)만 받는다. 값·해시는 받지 않는다.
 * 상태 enum·키 형식·대상 종류와의 짝·금고 키 정합을 검사한 뒤 대상에 저장(직전 점검 결과는 통째로 교체).
 */
export async function recordDrift(
  ctx: Actor,
  targetId: string,
  input: { results?: unknown },
  meta: Meta,
): Promise<{ target: EnvTargetRow; counts: Record<string, number> }> {
  const t = await findTarget(ctx, targetId);
  const vault = await prisma.envVar.findMany({
    where: { workspaceId: ctx.workspaceId, projectId: t.projectId, env: t.env },
    select: { key: true },
  });
  let results: DriftResults;
  try {
    results = validateDriftResults(input.results, t.kind, vault.map((v) => v.key));
  } catch (e) {
    if (e instanceof DriftInputError) throw new EnvVaultError(400, e.message);
    throw e;
  }
  const u = await prisma.envTarget.update({
    where: { id: t.id },
    data: { lastDrift: results as Prisma.InputJsonValue, lastDriftAt: new Date() },
    select: TARGET_SELECT,
  });
  await logAccess(ctx, meta, { action: "drift", projectId: t.projectId, env: t.env, keys: Object.keys(results), targetId: t.id });
  const g = groupDrift(results);
  return { target: toTargetRow(u), counts: Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.length])) };
}
