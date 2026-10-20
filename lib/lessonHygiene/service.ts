/* =====================================================================
   레슨 주간 정리 — IO(DB·LLM·승인 카드). 순수 계산은 signals·proposal·llm.

   흐름: 워커(월요일 10시 이후, Asia/Seoul) → runWeeklyHygiene(워크스페이스·ISO 주마다 1번 — DB unique 가 보장)
         → 제안이 없으면 status=empty(카드 없음), 있으면 status=proposed + 고위험 승인 카드(사람만 결정)
         → 워커가 매 tick processHygieneDecisions 로 승인 상태를 폴링(승인 결정 디스패처가 따로 없다 —
           env 금고도 같은 pull 방식) → approved 면 applyHygieneRun(트랜잭션, 적용 전 백업), rejected 면 rejected.
   되돌리기: revertHygieneRun — 백업한 레슨 행을 원래 id 그대로 다시 만들거나 되돌린다.
   ===================================================================== */

import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";
import { invalidateGraphCache } from "@/lib/graphLoad";
import { sendApproval } from "@/lib/approvals";
import { hasLLM } from "@/lib/llm";
import { digestWeekKey, zonedParts } from "@/lib/digest";
import { buildClusters, chunkClusters, computeSignals, signalCount, STALE_DAYS, type HygieneLesson, type HygieneSignals } from "./signals";
import {
  actionCount,
  affectedIds,
  cardBody,
  countsLine,
  emptyProposal,
  isEmptyProposal,
  mergeProposals,
  validateProposal,
  type Proposal,
  type ValidateLesson,
} from "./proposal";
import { proposeForChunks, type LlmRunner } from "./llm";

export class HygieneError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const HYGIENE_ANCHOR = "/settings#lesson-hygiene";

/** 월요일 10:00 이후(Asia/Seoul) — 그 주 안에서는 DB unique(workspaceId, weekKey)가 한 번만 돌게 한다. */
export function inHygieneWindow(now: Date): boolean {
  const p = zonedParts(now);
  return p.wd === 1 && p.h >= 10;
}

export const hygieneWeekKey = (now: Date) => digestWeekKey(now);

export function hygieneEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.LESSON_HYGIENE || "").trim().toLowerCase() !== "off";
}

function hygieneLink(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "") ?? "";
  return `${base}${HYGIENE_ANCHOR}`;
}

/* ── 제안 만들기 ──────────────────────────────────────────────────── */

const LESSON_SELECT = { id: true, title: true, body: true, projectId: true, stack: true, userId: true, mode: true, keywords: true, createdAt: true } as const;

export type BuiltProposal = { proposal: Proposal; signals: HygieneSignals; titles: Map<string, string>; llm: { calls: number; failed: number; enabled: boolean } };

export async function buildHygieneProposal(workspaceId: string, o: { now?: Date; days?: number; run?: LlmRunner } = {}): Promise<BuiltProposal> {
  const now = o.now ?? new Date();
  const days = o.days ?? STALE_DAYS;
  const since = new Date(now.getTime() - days * 86_400_000);
  const [lessons, injections, reads, projects] = await Promise.all([
    prisma.lesson.findMany({ where: { workspaceId }, select: LESSON_SELECT }),
    prisma.lessonInjection.findMany({ where: { workspaceId, createdAt: { gte: since } }, select: { projectId: true, gistIds: true, titleIds: true } }),
    prisma.lessonRead.findMany({ where: { workspaceId, createdAt: { gte: since } }, select: { lessonId: true }, distinct: ["lessonId"] }),
    prisma.project.findMany({ where: { workspaceId }, select: { id: true, name: true, stack: true, archivedAt: true } }),
  ]);
  const signals = computeSignals({ lessons: lessons as HygieneLesson[], injections, reads, projects, days, now });
  const titles = new Map(lessons.map((l) => [l.id, l.title]));
  const liveProjects = projects.filter((p) => !p.archivedAt).map((p) => ({ id: p.id, name: p.name }));
  const ctx = { lessons: new Map<string, ValidateLesson>(lessons.map((l) => [l.id, l])), projects: liveProjects };
  if (signalCount(signals) === 0) return { proposal: emptyProposal(), signals, titles, llm: { calls: 0, failed: 0, enabled: hasLLM() } };

  const byId = new Map((lessons as HygieneLesson[]).map((l) => [l.id, l]));
  const chunks = chunkClusters(buildClusters(signals, lessons as HygieneLesson[]));
  const enabled = !!o.run || hasLLM();
  const run: LlmRunner | undefined = enabled ? o.run : async () => null; // off 면 호출 없이 폴백
  const r = await proposeForChunks(chunks, { lessons: byId, projects: liveProjects, workspaceId, ctx, run });
  const proposal = mergeProposals(r.parts, ctx);
  return { proposal, signals, titles, llm: { calls: enabled ? r.llmCalls : 0, failed: enabled ? r.llmFailed : 0, enabled } };
}

function summaryOf(b: BuiltProposal): string {
  const s = b.signals;
  const lines = [
    countsLine(b.proposal),
    `신호: 주입·조회 0회 ${s.stale.length} · 키워드 없는 ondemand ${s.ondemandNoKeywords.length} · 비슷한 제목 ${s.similarPairs.length}쌍${s.requiredOver ? ` · 필수 ${s.requiredOver.count}개(>${s.requiredOver.max})` : ""}`,
    b.llm.enabled ? `LLM ${b.llm.calls}회${b.llm.failed ? `(실패 ${b.llm.failed} — 그 묶음은 검토 항목으로만)` : ""}` : "LLM 꺼짐 — 신호를 검토 항목으로만",
  ];
  return lines.join("\n");
}

/* ── 주간 실행(워크스페이스·주마다 1번) ─────────────────────────────── */

export type RunRow = Awaited<ReturnType<typeof prisma.lessonHygieneRun.findUnique>>;

export type WeeklyResult =
  | { dryRun: true; weekKey: string; proposal: Proposal; signals: HygieneSignals; summary: string }
  | { dryRun: false; created: boolean; weekKey: string; run: NonNullable<RunRow>; sent?: boolean; error?: string };

const isUnique = (e: unknown) => (e as { code?: string })?.code === "P2002";

export async function runWeeklyHygiene(workspaceId: string, o: { now?: Date; dryRun?: boolean; run?: LlmRunner; createdBy?: string } = {}): Promise<WeeklyResult> {
  const now = o.now ?? new Date();
  const weekKey = hygieneWeekKey(now);
  if (!o.dryRun) {
    const existing = await prisma.lessonHygieneRun.findUnique({ where: { workspaceId_weekKey: { workspaceId, weekKey } } });
    if (existing) return { dryRun: false, created: false, weekKey, run: existing };
  }
  const built = await buildHygieneProposal(workspaceId, { now, run: o.run });
  const summary = summaryOf(built);
  if (o.dryRun) return { dryRun: true, weekKey, proposal: built.proposal, signals: built.signals, summary };

  const empty = isEmptyProposal(built.proposal);
  let run: NonNullable<RunRow>;
  try {
    run = await prisma.lessonHygieneRun.create({
      data: { workspaceId, weekKey, status: empty ? "empty" : "proposed", proposal: built.proposal as object, signals: built.signals as object, summary },
    });
  } catch (e) {
    if (!isUnique(e)) throw e;
    const existing = await prisma.lessonHygieneRun.findUnique({ where: { workspaceId_weekKey: { workspaceId, weekKey } } });
    if (!existing) throw e;
    return { dryRun: false, created: false, weekKey, run: existing };
  }
  if (empty) return { dryRun: false, created: true, weekKey, run };

  const channel = process.env.LESSON_HYGIENE_CHANNEL?.trim() || undefined; // 없으면 sendApproval 이 SlackInstall 기본 채널로
  const body = cardBody(built.proposal, { weekKey, runId: run.id, titles: built.titles, link: hygieneLink() });
  const ap = await sendApproval(workspaceId, {
    title: `레슨 주간 정리 ${weekKey} — ${actionCount(built.proposal)}건`,
    body,
    channel,
    kind: "general",
    highRisk: true, // 레슨 삭제가 들어간다 — 사람만 결정(에이전트 토큰 PATCH 는 403)
    ...(o.createdBy ? { createdBy: o.createdBy } : {}),
  });
  const note = ap.sent ? "" : `\n카드 발송 실패(${ap.error ?? "unknown"}) — 앱 승인 화면에서 결정할 수 있습니다.`;
  run = await prisma.lessonHygieneRun.update({ where: { id: run.id }, data: { approvalId: ap.id, summary: summary + note } });
  return { dryRun: false, created: true, weekKey, run, sent: ap.sent, ...(ap.error ? { error: ap.error } : {}) };
}

/** 워커 진입점 — 창 안이면 모든 워크스페이스에 한 번씩. 한 워크스페이스 실패가 나머지를 막지 않는다. */
export async function runWeeklyHygieneAll(now: Date = new Date()): Promise<{ weekKey: string; created: number; failed: number }> {
  const weekKey = hygieneWeekKey(now);
  const workspaces = await prisma.workspace.findMany({ select: { id: true } });
  let created = 0;
  let failed = 0;
  for (const w of workspaces) {
    try {
      const r = await runWeeklyHygiene(w.id, { now });
      if (!r.dryRun && r.created) {
        created++;
        log.info("lesson_hygiene.run_created", { msg: `레슨 주간 정리 ${weekKey}: ${r.run.status}`, workspaceId: w.id, weekKey, status: r.run.status, sent: r.sent ?? null });
      }
    } catch (e) {
      failed++;
      log.warn("lesson_hygiene.run_failed", { msg: "레슨 주간 정리 실패", workspaceId: w.id, weekKey, err: e });
    }
  }
  return { weekKey, created, failed };
}

/* ── 승인 → 적용 ──────────────────────────────────────────────────── */

type LessonRow = NonNullable<Awaited<ReturnType<typeof prisma.lesson.findUnique>>>;
export type HygieneBackup = { lessons: LessonRow[]; applied: Proposal; skipped: string[] };

function scopeData(to: string): { projectId: string | null; stack: string | null } {
  if (to.startsWith("project:")) return { projectId: to.slice(8), stack: null };
  if (to.startsWith("stack:")) return { projectId: null, stack: to.slice(6) };
  return { projectId: null, stack: null };
}

/**
 * 승인된 제안을 한 트랜잭션으로 적용. 같은 run 을 둘이 동시에 적용하지 못하게 첫 문장에서 proposed→applied 로 선점한다
 * (실패하면 트랜잭션째 되돌아가 proposed 로 남고, 바깥에서 failed 로 표시).
 * 제안 이후 누가 고친 레슨(updatedAt > run.createdAt)·사라진 레슨은 건너뛴다 — 현재 행으로 다시 검증한다.
 */
export async function applyHygieneRun(runId: string, now: Date = new Date()): Promise<{ status: string; applied: number; skipped: string[] }> {
  const run = await prisma.lessonHygieneRun.findUnique({ where: { id: runId } });
  if (!run) throw new HygieneError(404, "정리 실행을 찾을 수 없습니다.");
  if (run.status !== "proposed") return { status: run.status, applied: 0, skipped: [] };
  const original = run.proposal as unknown as Proposal;
  try {
    const r = await prisma.$transaction(async (tx) => {
      const claim = await tx.lessonHygieneRun.updateMany({ where: { id: runId, status: "proposed" }, data: { status: "applied", appliedAt: now } });
      if (claim.count !== 1) return null;
      const ids = affectedIds(original);
      const rows = (await tx.lesson.findMany({ where: { workspaceId: run.workspaceId, id: { in: ids } } })) as LessonRow[];
      const projects = await tx.project.findMany({ where: { workspaceId: run.workspaceId, archivedAt: null }, select: { id: true, name: true } });
      const fresh = rows.filter((l) => l.updatedAt.getTime() <= run.createdAt.getTime());
      const freshIds = new Set(fresh.map((l) => l.id));
      const skipped = ids.filter((id) => !freshIds.has(id));
      const p = validateProposal(original, { lessons: new Map<string, ValidateLesson>(fresh.map((l) => [l.id, l])), projects });
      const touched = new Set(affectedIds(p));
      const backup: HygieneBackup = { lessons: rows.filter((l) => touched.has(l.id)), applied: p, skipped };

      for (const m of p.merges) {
        await tx.lesson.update({ where: { id: m.keepId }, data: { title: m.newTitle, body: m.newBody } });
        await tx.lesson.deleteMany({ where: { workspaceId: run.workspaceId, id: { in: m.mergeIds }, userId: null } });
      }
      if (p.drops.length) await tx.lesson.deleteMany({ where: { workspaceId: run.workspaceId, id: { in: p.drops.map((d) => d.id) }, userId: null } });
      for (const s of p.scopeFixes) await tx.lesson.update({ where: { id: s.id }, data: scopeData(s.to) });
      for (const q of p.required) await tx.lesson.update({ where: { id: q.id }, data: { mode: q.to } });
      for (const o of p.ondemand) await tx.lesson.update({ where: { id: o.id }, data: { keywords: o.keywords } });

      const n = actionCount(p);
      await tx.lessonHygieneRun.update({
        where: { id: runId },
        data: { backup: JSON.parse(JSON.stringify(backup)), summary: `${run.summary}\n적용 ${now.toISOString().slice(0, 16)}: ${countsLine(p)}${skipped.length ? ` · 건너뜀 ${skipped.length}(제안 뒤 수정·삭제됨)` : ""}` },
      });
      return { applied: n, skipped };
    });
    if (!r) {
      const cur = await prisma.lessonHygieneRun.findUnique({ where: { id: runId }, select: { status: true } });
      return { status: cur?.status ?? "missing", applied: 0, skipped: [] };
    }
    // 레슨은 그래프 노드다. 워커 프로세스라 웹의 메모리 캐시는 못 비우고 DB 세대로 알린다(lib/graphLoad).
    invalidateGraphCache(run.workspaceId);
    log.info("lesson_hygiene.applied", { msg: `레슨 주간 정리 적용 ${run.weekKey}: ${r.applied}건`, workspaceId: run.workspaceId, runId, applied: r.applied, skipped: r.skipped.length });
    return { status: "applied", ...r };
  } catch (e) {
    log.warn("lesson_hygiene.apply_failed", { msg: "레슨 주간 정리 적용 실패", runId, err: e });
    await prisma.lessonHygieneRun.updateMany({
      where: { id: runId, status: "proposed" },
      data: { status: "failed", summary: `${run.summary}\n적용 실패: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}` },
    });
    return { status: "failed", applied: 0, skipped: [] };
  }
}

/** 워커 매 tick — 승인 상태를 본다(proposed 가 없으면 쿼리 1번). */
export async function processHygieneDecisions(now: Date = new Date()): Promise<{ applied: number; rejected: number; failed: number }> {
  const runs = await prisma.lessonHygieneRun.findMany({ where: { status: "proposed", approvalId: { not: null } }, select: { id: true, approvalId: true, workspaceId: true } });
  const out = { applied: 0, rejected: 0, failed: 0 };
  if (!runs.length) return out;
  const approvals = await prisma.approval.findMany({ where: { id: { in: runs.map((r) => r.approvalId as string) } }, select: { id: true, status: true, workspaceId: true } });
  const byId = new Map(approvals.map((a) => [a.id, a]));
  for (const r of runs) {
    const ap = byId.get(r.approvalId as string);
    if (!ap || ap.workspaceId !== r.workspaceId) continue;
    if (ap.status === "approved") {
      const res = await applyHygieneRun(r.id, now);
      if (res.status === "applied") out.applied++;
      else if (res.status === "failed") out.failed++;
    } else if (ap.status === "rejected") {
      const u = await prisma.lessonHygieneRun.updateMany({ where: { id: r.id, status: "proposed" }, data: { status: "rejected" } });
      out.rejected += u.count;
    }
  }
  return out;
}

/* ── 되돌리기 ─────────────────────────────────────────────────────── */

const toDate = (v: unknown): Date | undefined => (v ? new Date(v as string) : undefined);

/** 적용된 정리를 백업으로 되돌린다 — 지운 레슨은 원래 id 로 다시 만들고, 바꾼 레슨은 적용 전 값으로. */
export async function revertHygieneRun(workspaceId: string, runId: string, now: Date = new Date()): Promise<{ restored: number; recreated: number }> {
  const run = await prisma.lessonHygieneRun.findFirst({ where: { id: runId, workspaceId } });
  if (!run) throw new HygieneError(404, "정리 실행을 찾을 수 없습니다.");
  if (run.status !== "applied") throw new HygieneError(409, `적용된 정리만 되돌릴 수 있습니다(현재 ${run.status}).`);
  const backup = run.backup as unknown as HygieneBackup | null;
  if (!backup?.lessons) throw new HygieneError(409, "백업이 없어 되돌릴 수 없습니다.");
  return prisma.$transaction(async (tx) => {
    const claim = await tx.lessonHygieneRun.updateMany({ where: { id: runId, status: "applied" }, data: { status: "reverted", revertedAt: now } });
    if (claim.count !== 1) throw new HygieneError(409, "이미 되돌렸거나 상태가 바뀌었습니다.");
    const projectIds = new Set((await tx.project.findMany({ where: { workspaceId }, select: { id: true } })).map((p) => p.id));
    const existing = new Set((await tx.lesson.findMany({ where: { workspaceId, id: { in: backup.lessons.map((l) => l.id) } }, select: { id: true } })).map((l) => l.id));
    let restored = 0;
    let recreated = 0;
    for (const l of backup.lessons) {
      const data = {
        title: l.title,
        body: l.body,
        // 그사이 프로젝트가 지워졌으면 FK 가 깨진다 — 전역으로(Lesson.project onDelete:SetNull 과 같은 결과)
        projectId: l.projectId && projectIds.has(l.projectId) ? l.projectId : null,
        stack: l.stack ?? null,
        userId: l.userId ?? null,
        mode: l.mode,
        keywords: l.keywords ?? [],
      };
      if (existing.has(l.id)) {
        await tx.lesson.update({ where: { id: l.id }, data });
        restored++;
      } else {
        await tx.lesson.create({ data: { id: l.id, workspaceId, ...data, createdById: l.createdById ?? null, createdAt: toDate(l.createdAt) } });
        recreated++;
      }
    }
    await tx.lessonHygieneRun.update({ where: { id: runId }, data: { summary: `${run.summary}\n되돌림 ${now.toISOString().slice(0, 16)}: 복원 ${restored} · 재생성 ${recreated}` } });
    return { restored, recreated };
  });
}

/* ── 조회 ─────────────────────────────────────────────────────────── */

export async function listHygieneRuns(workspaceId: string, limit = 20) {
  const runs = await prisma.lessonHygieneRun.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 100),
    select: { id: true, weekKey: true, status: true, summary: true, approvalId: true, appliedAt: true, revertedAt: true, createdAt: true, proposal: true },
  });
  return runs.map(({ proposal, ...r }) => {
    const p = proposal as unknown as Proposal;
    return { ...r, counts: { merges: p.merges?.length ?? 0, drops: p.drops?.length ?? 0, scopeFixes: p.scopeFixes?.length ?? 0, required: p.required?.length ?? 0, ondemand: p.ondemand?.length ?? 0, review: p.review?.length ?? 0 } };
  });
}

/** 한 실행 전체 + 제목 사전(지금 있는 레슨은 DB, 지워진 레슨은 백업에서). 개인 레슨은 애초에 제안에 없다. */
export async function getHygieneRun(workspaceId: string, runId: string) {
  const run = await prisma.lessonHygieneRun.findFirst({ where: { id: runId, workspaceId } });
  if (!run) throw new HygieneError(404, "정리 실행을 찾을 수 없습니다.");
  const p = run.proposal as unknown as Proposal;
  const ids = [...new Set([...affectedIds(p), ...(p.review ?? []).map((r) => r.id)])];
  const live = await prisma.lesson.findMany({ where: { workspaceId, id: { in: ids }, userId: null }, select: { id: true, title: true } });
  const titles: Record<string, string> = {};
  for (const l of (run.backup as unknown as HygieneBackup | null)?.lessons ?? []) titles[l.id] = l.title;
  for (const l of live) titles[l.id] = l.title;
  const { backup, ...rest } = run;
  return { run: { ...rest, hasBackup: !!backup }, titles, liveIds: live.map((l) => l.id) };
}
