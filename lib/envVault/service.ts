import { prisma } from "@/lib/prisma";
import { sendApproval } from "@/lib/approvals";
import type { Ctx } from "@/lib/workspace";
import { openValue, sealValue, valueDigest, varAad } from "./crypto";
import { accountSummary, syncState, targetSummary, type SyncState } from "./targets";
import { ENV_KEY_RE, importDiff, type ImportDiff, type ImportMode } from "./diff";
import { driftIssueCount, driftMap, type DriftResults, type DriftStatus } from "./drift";
import { computeSyncGroups, type SyncGroupRow } from "./syncGroups";

export { computeSyncGroups, type SyncGroupRow };

export { importDiff, type ImportDiff, type ImportMode };

/* =====================================================================
   env 금고 서비스 (P1). 라우트는 권한·입력 형식만 보고 여기로 넘긴다.

   불변식
   - 값(평문)은 반환값(reveal·pull 만)에만 실린다. 로그·에러 메시지·감사 기록에는
     키 이름만 남긴다.
   - CLI 쓰기(import)는 바로 쓰지 않는다: 봉인된 대기 작업(EnvOp) + 고위험 승인을 만들고,
     사람이 승인한 뒤에만 applyImport 가 반영한다(CLI 는 항상 에이전트 토큰이라
     토큰 종류로 사람을 가를 수 없다 — 사람 확인 = 승인 클릭).
   - 모든 동작은 EnvAccessLog 에 남는다.
   ===================================================================== */

export const KEY_RE = ENV_KEY_RE;
export const ENV_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const MAX_VALUE_BYTES = 64 * 1024;
export const MAX_IMPORT_VARS = 500;
export const IMPORT_TTL_MS = 30 * 60 * 1000;

export class EnvVaultError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type Meta = { viaFunnel: boolean };
type Actor = Pick<Ctx, "workspaceId" | "userId" | "actor">;

export type EnvAction =
  | "list" | "reveal" | "set" | "delete" | "import_request" | "import_apply" | "pull"
  | "push_request" | "push" | "push_result" | "target_add" | "target_update" | "target_delete" | "drift" | "drift_read" | "meta";

/** pull 목적 — 값이 나가는 것은 같고(감사 1행) 감사 라벨만 다르다. drift = 드리프트 점검용 메모리 비교. */
export type PullPurpose = "pull" | "drift";
export function checkPullPurpose(v: unknown): PullPurpose {
  if (v === undefined || v === null || v === "pull") return "pull";
  if (v === "drift") return "drift";
  throw new EnvVaultError(400, "purpose 는 pull 또는 drift 입니다.");
}

export async function logAccess(
  ctx: Actor,
  meta: Meta,
  e: { action: EnvAction; projectId?: string | null; env?: string | null; keys?: string[]; targetId?: string | null },
): Promise<void> {
  await prisma.envAccessLog.create({
    data: {
      workspaceId: ctx.workspaceId,
      projectId: e.projectId ?? null,
      env: e.env ?? null,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      actorName: ctx.actor.name,
      action: e.action,
      keys: e.keys ?? [],
      targetId: e.targetId ?? null,
      viaFunnel: meta.viaFunnel,
    },
  });
}

// ── 입력 검증 (메시지에 값을 넣지 않는다) ─────────────────────────────────
export function checkEnv(env: unknown): string {
  if (typeof env !== "string" || !ENV_RE.test(env)) {
    throw new EnvVaultError(400, "env 이름은 영문·숫자·_- 1~32자여야 합니다.");
  }
  return env;
}
export function checkKey(key: unknown): string {
  if (typeof key !== "string" || !KEY_RE.test(key)) {
    throw new EnvVaultError(400, `키 이름 형식이 올바르지 않습니다(^[A-Z_][A-Z0-9_]*$): ${String(key).slice(0, 80)}`);
  }
  return key;
}
export function checkValue(value: unknown, key: string): string {
  if (typeof value !== "string") throw new EnvVaultError(400, `${key} 값은 문자열이어야 합니다.`);
  // 빈 값은 저장하지 않는다 — '키는 있는데 값이 비어 있음' 이 pull 된 .env 에서 조용히 설정 누락이 된다
  if (value === "") throw new EnvVaultError(400, "값을 입력해 주세요.");
  if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) throw new EnvVaultError(400, `${key} 값이 64KB 를 넘습니다.`);
  return value;
}

export async function requireProject(workspaceId: string, projectId: unknown): Promise<{ id: string; name: string }> {
  if (typeof projectId !== "string" || !projectId.trim()) throw new EnvVaultError(400, "projectId 가 필요합니다.");
  const p = await prisma.project.findFirst({ where: { id: projectId.trim(), workspaceId }, select: { id: true, name: true } });
  if (!p) throw new EnvVaultError(400, "프로젝트를 찾을 수 없습니다.");
  return p;
}

// ── 목록 (값 없음) ────────────────────────────────────────────────────────
export type EnvVarRow = {
  id: string;
  projectId: string;
  env: string;
  key: string;
  version: number;
  valueLength: number;
  note: string | null;
  syncGroup: string | null;
  updatedById: string | null;
  updatedByName: string | null;
  updatedAt: Date;
  /** 대상 id → 동기 상태(이 키의 env 와 같은 env 의 대상만). 값·지문은 싣지 않는다. */
  sync: Record<string, SyncState>;
  /** 대상 id → 마지막 드리프트 점검 상태(이 키의 env 와 같은 env 의 대상 중 점검 기록이 있는 것만). */
  drift: Record<string, DriftStatus>;
};

export type EnvTargetRow = {
  id: string;
  projectId: string;
  env: string;
  kind: string;
  config: unknown;
  account: unknown;
  summary: string;
  accountSummary: string;
  lastPushedAt: Date | null;
  /** 마지막 반영에 들어간 키 이름(지문은 싣지 않는다) */
  lastPushedKeys: string[];
  /** 마지막 드리프트 점검(P3a) — 키 → 상태(값·해시 없음) */
  lastDriftAt: Date | null;
  lastDrift: DriftResults;
  /** 점검에서 다름·원격 없음·원격에만 인 키 수 */
  driftIssues: number;
  createdAt: Date;
  updatedAt: Date;
};

type TargetDbRow = {
  id: string; projectId: string; env: string; kind: string; config: unknown; account: unknown;
  lastPushedAt: Date | null; lastPushed: unknown; lastDriftAt: Date | null; lastDrift: unknown; createdAt: Date; updatedAt: Date;
};
export const TARGET_SELECT = {
  id: true, projectId: true, env: true, kind: true, config: true, account: true,
  lastPushedAt: true, lastPushed: true, lastDriftAt: true, lastDrift: true, createdAt: true, updatedAt: true,
} as const;

export function digestMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
}

export function toTargetRow(t: TargetDbRow): EnvTargetRow {
  return {
    id: t.id, projectId: t.projectId, env: t.env, kind: t.kind, config: t.config, account: t.account,
    summary: targetSummary(t.kind, t.config), accountSummary: accountSummary(t.kind, t.account),
    lastPushedAt: t.lastPushedAt, lastPushedKeys: Object.keys(digestMap(t.lastPushed)).sort(),
    lastDriftAt: t.lastDriftAt, lastDrift: driftMap(t.lastDrift), driftIssues: driftIssueCount(driftMap(t.lastDrift)),
    createdAt: t.createdAt, updatedAt: t.updatedAt,
  };
}

export async function listVars(
  ctx: Actor,
  q: { projectId?: string | null; env?: string | null },
): Promise<{ vars: EnvVarRow[]; envs: string[]; targets: EnvTargetRow[] }> {
  const projectId = q.projectId ? (await requireProject(ctx.workspaceId, q.projectId)).id : null;
  const env = q.env ? checkEnv(q.env) : null;
  const rows = await prisma.envVar.findMany({
    where: { workspaceId: ctx.workspaceId, ...(projectId ? { projectId } : {}), ...(env ? { env } : {}) },
    orderBy: [{ env: "asc" }, { key: "asc" }],
    select: {
      id: true, projectId: true, env: true, key: true, version: true, valueLength: true,
      note: true, syncGroup: true, updatedById: true, updatedAt: true, sealed: true,
    },
  });
  const targets = projectId
    ? await prisma.envTarget.findMany({
        where: { workspaceId: ctx.workspaceId, projectId, ...(env ? { env } : {}) },
        orderBy: [{ env: "asc" }, { kind: "asc" }, { createdAt: "asc" }],
        select: TARGET_SELECT,
      })
    : [];
  const envRows = await prisma.envVar.findMany({
    where: { workspaceId: ctx.workspaceId, ...(projectId ? { projectId } : {}) },
    distinct: ["env"],
    select: { env: true },
    orderBy: { env: "asc" },
  });
  const userIds = [...new Set(rows.map((r) => r.updatedById).filter((x): x is string => !!x))];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } })
    : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name ?? u.email]));
  // 목록(값 없음)은 감사 로그에 남기지 않는다 — 화면을 볼 때마다 쌓여 열람·설정 기록을 묻었다.
  // (EnvAction 의 "list" 는 기존 행 호환용으로만 남긴다)
  // 동기 상태: 같은 env 의 대상이 있을 때만 값을 서버 안에서 열어 지문을 비교한다(값·지문은 응답에 없음)
  const byEnv = new Map<string, TargetDbRow[]>();
  for (const t of targets) byEnv.set(t.env, [...(byEnv.get(t.env) ?? []), t]);
  return {
    vars: rows.map(({ sealed, ...r }) => {
      const ts = byEnv.get(r.env) ?? [];
      const sync: Record<string, SyncState> = {};
      const drift: Record<string, DriftStatus> = {};
      if (ts.length) {
        const d = valueDigest(openValue(sealed, varAad(ctx.workspaceId, r.projectId, r.env, r.key)));
        for (const t of ts) {
          sync[t.id] = syncState(d, digestMap(t.lastPushed), r.key);
          const st = driftMap(t.lastDrift)[r.key];
          if (st) drift[t.id] = st;
        }
      }
      return { ...r, sync, drift, updatedByName: r.updatedById ? nameOf.get(r.updatedById) ?? null : null };
    }),
    envs: envRows.map((r) => r.env),
    targets: targets.map(toTargetRow),
  };
}

// ── 값 설정·삭제 ──────────────────────────────────────────────────────────
type SetInput = { projectId: unknown; env: unknown; key: unknown; value: unknown; note?: unknown; syncGroup?: unknown };

function optText(v: unknown, max = 200): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw new EnvVaultError(400, "note·syncGroup 은 문자열이어야 합니다.");
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/** 이 워크스페이스 행 하나를 upsert. 덮어쓸 때는 직전 암호문을 이력으로 남기고 version+1. */
async function upsertSealed(
  tx: Pick<typeof prisma, "envVar" | "envVarVersion">,
  ctx: Actor,
  p: { projectId: string; env: string; key: string; value: string; note?: string | null; syncGroup?: string | null },
): Promise<{ id: string; version: number; created: boolean }> {
  const sealed = sealValue(p.value, varAad(ctx.workspaceId, p.projectId, p.env, p.key));
  const valueLength = [...p.value].length;
  const existing = await tx.envVar.findUnique({
    where: { projectId_env_key: { projectId: p.projectId, env: p.env, key: p.key } },
    select: { id: true, sealed: true, version: true, updatedById: true, workspaceId: true },
  });
  if (existing) {
    if (existing.workspaceId !== ctx.workspaceId) throw new EnvVaultError(404, "대상을 찾을 수 없습니다.");
    await tx.envVarVersion.create({
      data: { varId: existing.id, version: existing.version, sealed: existing.sealed, updatedById: existing.updatedById },
    });
    const u = await tx.envVar.update({
      where: { id: existing.id },
      data: {
        sealed, valueLength, version: existing.version + 1, updatedById: ctx.userId,
        ...(p.note !== undefined ? { note: p.note } : {}),
        ...(p.syncGroup !== undefined ? { syncGroup: p.syncGroup } : {}),
      },
      select: { id: true, version: true },
    });
    return { ...u, created: false };
  }
  const c = await tx.envVar.create({
    data: {
      workspaceId: ctx.workspaceId, projectId: p.projectId, env: p.env, key: p.key,
      sealed, valueLength, updatedById: ctx.userId,
      note: p.note ?? null, syncGroup: p.syncGroup ?? null,
    },
    select: { id: true, version: true },
  });
  return { ...c, created: true };
}

export async function setVar(ctx: Actor, input: SetInput, meta: Meta): Promise<{ id: string; version: number; created: boolean }> {
  const project = await requireProject(ctx.workspaceId, input.projectId);
  const env = checkEnv(input.env);
  const key = checkKey(input.key);
  const value = checkValue(input.value, key);
  const note = optText(input.note);
  const syncGroup = optText(input.syncGroup, 64);
  const r = await prisma.$transaction((tx) => upsertSealed(tx, ctx, { projectId: project.id, env, key, value, note, syncGroup }));
  await logAccess(ctx, meta, { action: "set", projectId: project.id, env, keys: [key] });
  return r;
}

export async function deleteVar(ctx: Actor, id: string, meta: Meta): Promise<void> {
  const row = await prisma.envVar.findFirst({ where: { id, workspaceId: ctx.workspaceId }, select: { id: true, projectId: true, env: true, key: true } });
  if (!row) throw new EnvVaultError(404, "키를 찾을 수 없습니다.");
  await prisma.envVar.delete({ where: { id: row.id } });
  await logAccess(ctx, meta, { action: "delete", projectId: row.projectId, env: row.env, keys: [row.key] });
}

/** 값은 그대로 두고 메모·syncGroup 만 바꾼다(관리자 세션). 빈 문자열·null 은 지움. */
export async function updateVarMeta(
  ctx: Actor,
  id: string,
  input: { note?: unknown; syncGroup?: unknown },
  meta: Meta,
): Promise<{ id: string; note: string | null; syncGroup: string | null }> {
  const note = optText(input.note);
  const syncGroup = optText(input.syncGroup, 64);
  if (note === undefined && syncGroup === undefined) throw new EnvVaultError(400, "바꿀 note 또는 syncGroup 이 필요합니다.");
  const row = await prisma.envVar.findFirst({ where: { id, workspaceId: ctx.workspaceId }, select: { id: true, projectId: true, env: true, key: true } });
  if (!row) throw new EnvVaultError(404, "키를 찾을 수 없습니다.");
  const u = await prisma.envVar.update({
    where: { id: row.id },
    data: { ...(note !== undefined ? { note } : {}), ...(syncGroup !== undefined ? { syncGroup } : {}) },
    select: { id: true, note: true, syncGroup: true },
  });
  await logAccess(ctx, meta, { action: "meta", projectId: row.projectId, env: row.env, keys: [row.key] });
  return u;
}

// ── syncGroup 일관성 (P3b) ────────────────────────────────────────────────
/** 워크스페이스 전체 syncGroup — 서버 안에서만 값을 열어 지문을 비교한다(응답에 값·지문 없음). */
export async function syncGroups(ctx: Actor): Promise<SyncGroupRow[]> {
  const rows = await prisma.envVar.findMany({
    where: { workspaceId: ctx.workspaceId, syncGroup: { not: null } },
    select: { id: true, projectId: true, env: true, key: true, sealed: true, syncGroup: true, project: { select: { name: true } } },
  });
  return computeSyncGroups(
    rows.map((r) => ({
      syncGroup: r.syncGroup as string,
      projectId: r.projectId, projectName: r.project.name, env: r.env, key: r.key, varId: r.id,
      digest: valueDigest(openValue(r.sealed, varAad(ctx.workspaceId, r.projectId, r.env, r.key))),
    })),
  );
}

// ── 값 열람 ───────────────────────────────────────────────────────────────
export async function reveal(
  ctx: Actor,
  ids: unknown,
  meta: Meta,
): Promise<{ id: string; env: string; key: string; value: string }[]> {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200 || !ids.every((x) => typeof x === "string")) {
    throw new EnvVaultError(400, "ids 는 1~200개의 문자열 배열이어야 합니다.");
  }
  const rows = await prisma.envVar.findMany({
    where: { id: { in: ids as string[] }, workspaceId: ctx.workspaceId },
    select: { id: true, projectId: true, env: true, key: true, sealed: true },
  });
  const out = rows.map((r) => ({ id: r.id, env: r.env, key: r.key, value: openValue(r.sealed, varAad(ctx.workspaceId, r.projectId, r.env, r.key)) }));
  // 프로젝트·env 가 섞일 수 있어 묶음별로 남긴다
  const groups = new Map<string, { projectId: string; env: string; keys: string[] }>();
  for (const r of rows) {
    const g = groups.get(`${r.projectId}\u0000${r.env}`) ?? { projectId: r.projectId, env: r.env, keys: [] };
    g.keys.push(r.key);
    groups.set(`${r.projectId}\u0000${r.env}`, g);
  }
  for (const g of groups.values()) await logAccess(ctx, meta, { action: "reveal", ...g });
  return out;
}

export async function pull(
  ctx: Actor,
  projectId: unknown,
  envIn: unknown,
  meta: Meta,
  purpose: PullPurpose = "pull",
): Promise<{ key: string; value: string }[]> {
  const project = await requireProject(ctx.workspaceId, projectId);
  const env = checkEnv(envIn);
  const rows = await prisma.envVar.findMany({
    where: { workspaceId: ctx.workspaceId, projectId: project.id, env },
    orderBy: { key: "asc" },
    select: { key: true, sealed: true },
  });
  const vars = rows.map((r) => ({ key: r.key, value: openValue(r.sealed, varAad(ctx.workspaceId, project.id, env, r.key)) }));
  // 값 반출마다 감사 1행 — 드리프트 점검용이면 "drift_read" 로 라벨만 바꾼다(반출 자체는 똑같이 남긴다).
  await logAccess(ctx, meta, { action: purpose === "drift" ? "drift_read" : "pull", projectId: project.id, env, keys: rows.map((r) => r.key) });
  return vars;
}

// ── import: 요청(승인 생성) → 적용 ──────────────────────────────────────
function parseImportVars(vars: unknown): { key: string; value: string }[] {
  if (!Array.isArray(vars) || vars.length === 0) throw new EnvVaultError(400, "vars 가 비어 있습니다.");
  if (vars.length > MAX_IMPORT_VARS) throw new EnvVaultError(400, `한 번에 ${MAX_IMPORT_VARS}개까지만 가져올 수 있습니다.`);
  const seen = new Set<string>();
  const empty: string[] = [];
  const out = vars.map((v) => {
    const o = (v ?? {}) as { key?: unknown; value?: unknown };
    const key = checkKey(o.key);
    if (seen.has(key)) throw new EnvVaultError(400, `중복 키: ${key}`);
    seen.add(key);
    if (o.value === "") {
      empty.push(key);
      return { key, value: "" };
    }
    return { key, value: checkValue(o.value, key) };
  });
  if (empty.length) throw new EnvVaultError(400, `값이 비어 있는 키가 있습니다: ${empty.join(", ")} — 값을 채우거나 빼고 다시 시도하세요.`);
  return out;
}

export function diffBody(projectName: string, env: string, mode: ImportMode, d: ImportDiff): string {
  const line = (label: string, ks: string[]) => (ks.length ? `*${label} ${ks.length}*: ${ks.join(", ")}` : null);
  return [
    `대상: ${projectName} / ${env} · 모드: ${mode === "overwrite" ? "덮어쓰기" : "합치기(있는 키 유지)"}`,
    line("추가", d.added),
    line("변경", d.changed),
    line("건너뜀", d.skipped),
    "값은 카드에 싣지 않습니다. 승인하면 CLI 가 적용합니다(30분 안).",
  ].filter(Boolean).join("\n");
}

export async function requestImport(
  ctx: Actor,
  input: { projectId: unknown; env: unknown; vars: unknown; mode?: unknown; channel?: unknown },
  meta: Meta,
): Promise<{ opId: string; approvalId: string; sent: boolean; error?: string; diff: ImportDiff; expiresAt: Date }> {
  const project = await requireProject(ctx.workspaceId, input.projectId);
  const env = checkEnv(input.env);
  const mode: ImportMode = input.mode === "overwrite" ? "overwrite" : "merge";
  const vars = parseImportVars(input.vars);
  const existing = await prisma.envVar.findMany({ where: { workspaceId: ctx.workspaceId, projectId: project.id, env }, select: { key: true } });
  const diff = importDiff(vars.map((v) => v.key), existing.map((e) => e.key), mode);
  const expiresAt = new Date(Date.now() + IMPORT_TTL_MS);

  const op = await prisma.$transaction(async (tx) => {
    const created = await tx.envOp.create({
      data: {
        workspaceId: ctx.workspaceId, projectId: project.id, env, kind: "import", mode,
        keys: vars.map((v) => v.key), createdById: ctx.userId, expiresAt,
      },
      select: { id: true },
    });
    // AAD 에 op id 를 묶어야 하므로 id 를 받은 뒤 봉인한다
    await tx.envOp.update({
      where: { id: created.id },
      data: { sealedPayload: sealValue(JSON.stringify(vars), `op:${created.id}`) },
    });
    return created;
  });

  const channel = typeof input.channel === "string" && input.channel.trim() ? input.channel.trim() : undefined;
  const ap = await sendApproval(ctx.workspaceId, {
    title: `env import: ${project.name}/${env} ${vars.length}개 키`,
    body: diffBody(project.name, env, mode, diff),
    channel,
    kind: "deploy",
    highRisk: true,
    createdBy: ctx.userId,
    projectId: project.id,
  });
  await prisma.envOp.update({ where: { id: op.id }, data: { approvalId: ap.id } });
  await logAccess(ctx, meta, { action: "import_request", projectId: project.id, env, keys: vars.map((v) => v.key) });
  return { opId: op.id, approvalId: ap.id, sent: ap.sent, ...(ap.error ? { error: ap.error } : {}), diff, expiresAt };
}

export async function applyImport(
  ctx: Actor,
  opId: string,
  meta: Meta,
): Promise<{ applied: ImportDiff }> {
  const op = await prisma.envOp.findFirst({ where: { id: opId, workspaceId: ctx.workspaceId } });
  if (!op) throw new EnvVaultError(404, "대기 작업을 찾을 수 없습니다.");
  if (op.status === "applied") throw new EnvVaultError(409, "이미 적용된 작업입니다.");
  if (op.status === "rejected" || op.status === "expired") throw new EnvVaultError(409, `이미 종료된 작업입니다(${op.status}).`);
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
  if (!op.sealedPayload) throw new EnvVaultError(409, "적용할 내용이 없습니다.");

  const vars = JSON.parse(openValue(op.sealedPayload, `op:${op.id}`)) as { key: string; value: string }[];
  const mode: ImportMode = op.mode === "overwrite" ? "overwrite" : "merge";

  const applied = await prisma.$transaction(async (tx) => {
    // 선점: pending 인 것만 한 번 적용(동시 apply 경합 방지)
    const claimed = await tx.envOp.updateMany({
      where: { id: op.id, status: "pending" },
      data: { status: "applied", appliedAt: new Date(), sealedPayload: null },
    });
    if (claimed.count !== 1) throw new EnvVaultError(409, "이미 적용 중이거나 적용된 작업입니다.");
    const existing = await tx.envVar.findMany({ where: { workspaceId: ctx.workspaceId, projectId: op.projectId, env: op.env }, select: { key: true } });
    const d = importDiff(vars.map((v) => v.key), existing.map((e) => e.key), mode);
    const write = new Set([...d.added, ...d.changed]);
    for (const v of vars) {
      if (write.has(v.key)) await upsertSealed(tx, ctx, { projectId: op.projectId, env: op.env, key: v.key, value: v.value });
    }
    return d;
  });
  await logAccess(ctx, meta, { action: "import_apply", projectId: op.projectId, env: op.env, keys: [...applied.added, ...applied.changed] });
  return { applied };
}

// ── 감사 로그 ─────────────────────────────────────────────────────────────
export async function accessLog(ctx: Actor, q: { projectId?: string | null; limit?: number }) {
  const take = Math.min(Math.max(q.limit ?? 50, 1), 200);
  return prisma.envAccessLog.findMany({
    where: { workspaceId: ctx.workspaceId, ...(q.projectId ? { projectId: q.projectId } : {}) },
    orderBy: { at: "desc" },
    take,
  });
}
