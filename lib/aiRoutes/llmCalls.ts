/* =====================================================================
   TeamSpace 자신의 LLM 호출 기록(LlmCall) — 기록·집계·정리.

   lib/llm.ts 가 호출마다 recordLlmCall 을 부른다. 기록은 fire-and-forget 이고
   어떤 실패도 호출측으로 새지 않는다(기록 때문에 기능이 죽으면 안 된다).
   프롬프트·응답 본문은 받지도 않는다 — 타입에 자리가 없다.
   ===================================================================== */

import { prisma } from "@/lib/prisma";
import { dayKey, recentDayKeys, p95 } from "@/lib/aiRoutes/relay";
import { estimateUsd } from "@/lib/llmCost";

export const LLM_CALL_RETENTION_DAYS = 90;

export type LlmCallRecord = {
  workspaceId?: string | null;
  feature: string;
  /** "cache" = 응답 캐시 적중(lib/llmCache) — 실제 호출 없음, 시간 0·토큰 null. */
  provider: "api" | "cli" | "cache";
  model: string;
  ok: boolean;
  errorKind?: string | null;
  durationMs: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
};

/** 1행 기록. 기다리지 않아도 되고, 기다려도 throw 하지 않는다. LLM_CALL_LOG=off 면 기록 안 함. */
export function recordLlmCall(r: LlmCallRecord): Promise<void> {
  if ((process.env.LLM_CALL_LOG || "").trim().toLowerCase() === "off") return Promise.resolve();
  try {
    return prisma.llmCall
      .create({
        data: {
          workspaceId: r.workspaceId ?? null,
          feature: (r.feature || "other").slice(0, 64),
          provider: r.provider,
          model: (r.model || "unknown").slice(0, 128),
          ok: r.ok,
          errorKind: r.errorKind ? r.errorKind.slice(0, 64) : null,
          durationMs: Math.max(0, Math.round(r.durationMs)),
          inputTokens: r.inputTokens ?? null,
          outputTokens: r.outputTokens ?? null,
        },
      })
      .then(
        () => undefined,
        () => undefined,
      );
  } catch {
    return Promise.resolve();
  }
}

/** 보존 기간 지난 행 삭제(워커 주기 + 집계 때 기회적으로). */
export async function purgeOldLlmCalls(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - LLM_CALL_RETENTION_DAYS * 86_400_000);
  const r = await prisma.llmCall.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return r.count;
}

/* ── 집계(순수) ───────────────────────────────────────────────────────── */

export type LlmCallRow = {
  feature: string;
  provider: string;
  model: string;
  ok: boolean;
  errorKind: string | null;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: Date;
};

type Agg = { calls: number; ok: number; failed: number; inputTokens: number; outputTokens: number; avgMs: number | null; p95Ms: number | null;
  /** 공개 단가 기준 추정 비용(USD). 토큰·단가를 아는 행만 합산, 하나도 없으면 null. */
  usd: number | null;
  /** 응답 캐시 적중(provider "cache") 행 수 — 위 지표(calls·ok·토큰·시간·usd)는 캐시 적중을 빼고 실제 호출만 센다. */
  cacheHits: number;
};

function agg(all: LlmCallRow[]): Agg {
  // 캐시 적중은 시간 0·토큰 null 이라 섞으면 평균 시간·성공률이 실제보다 좋아 보인다 — 따로 센다
  const rows = all.filter((r) => r.provider !== "cache");
  const durs = rows.map((r) => r.durationMs);
  const ok = rows.filter((r) => r.ok).length;
  const usds = rows.map((r) => estimateUsd(r.model, r.inputTokens, r.outputTokens)).filter((x): x is number => x !== null);
  return {
    calls: rows.length,
    ok,
    failed: rows.length - ok,
    inputTokens: rows.reduce((a, r) => a + (r.inputTokens ?? 0), 0),
    outputTokens: rows.reduce((a, r) => a + (r.outputTokens ?? 0), 0),
    avgMs: durs.length ? Math.round(durs.reduce((a, b) => a + b, 0) / durs.length) : null,
    p95Ms: p95(durs),
    usd: usds.length ? usds.reduce((a, b) => a + b, 0) : null,
    cacheHits: all.length - rows.length,
  };
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

export type TeamspaceUsage = {
  days: number;
  totals: Agg & { okRate: number | null };
  byDay: (Agg & { day: string })[];
  byFeature: (Agg & { feature: string; lastAt: string | null })[];
  byProvider: (Agg & { provider: string; models: string[] })[];
  errorKinds: { errorKind: string; count: number }[];
};

export function aggregateLlmCalls(rows: LlmCallRow[], opts: { days: number; now: Date; tz?: string }): TeamspaceUsage {
  const keys = recentDayKeys(opts.days, opts.now, opts.tz);
  const inWindow = new Set(keys);
  const win = rows.filter((r) => inWindow.has(dayKey(r.createdAt, opts.tz)));
  const byDayMap = groupBy(win, (r) => dayKey(r.createdAt, opts.tz));
  const totals = agg(win);
  const errs = groupBy(win.filter((r) => !r.ok), (r) => r.errorKind ?? "unknown");
  return {
    days: opts.days,
    totals: { ...totals, okRate: totals.calls ? totals.ok / totals.calls : null },
    byDay: keys.map((day) => ({ day, ...agg(byDayMap.get(day) ?? []) })),
    byFeature: [...groupBy(win, (r) => r.feature).entries()]
      .map(([feature, rs]) => ({
        feature,
        ...agg(rs),
        lastAt: rs.reduce<Date | null>((a, r) => (!a || r.createdAt > a ? r.createdAt : a), null)?.toISOString() ?? null,
      }))
      .sort((a, b) => b.calls - a.calls || b.cacheHits - a.cacheHits || a.feature.localeCompare(b.feature)),
    byProvider: [...groupBy(win, (r) => r.provider).entries()]
      .map(([provider, rs]) => ({ provider, ...agg(rs), models: [...new Set(rs.map((r) => r.model))].sort() }))
      .sort((a, b) => b.calls - a.calls || b.cacheHits - a.cacheHits),
    errorKinds: [...errs.entries()].map(([errorKind, rs]) => ({ errorKind, count: rs.length })).sort((a, b) => b.count - a.count),
  };
}

/** 워크스페이스 범위 기간 집계(DB). `purge:false` 면 보존 기간 정리를 건너뛴다(기본 true). 기간 시작보다 하루 넉넉히 읽고 날짜 키로 거른다. */
export async function getTeamspaceUsage(workspaceId: string, days: number, opts: { now?: Date; tz?: string; purge?: boolean } = {}): Promise<TeamspaceUsage> {
  const now = opts.now ?? new Date();
  // 기본은 기회적 정리. 읽기 전용 호출(ops 상태·주간 지표)은 purge:false 로 쓰기 부작용을 피한다.
  if (opts.purge !== false) await purgeOldLlmCalls(now).catch(() => 0);
  const since = new Date(now.getTime() - (days + 1) * 86_400_000);
  const rows = await prisma.llmCall.findMany({
    where: { workspaceId, createdAt: { gte: since } },
    select: { feature: true, provider: true, model: true, ok: true, errorKind: true, durationMs: true, inputTokens: true, outputTokens: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 50_000,
  });
  return aggregateLlmCalls(rows, { days, now, tz: opts.tz });
}
