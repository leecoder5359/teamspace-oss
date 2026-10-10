/* =====================================================================
   일일 LLM 토큰 예산 가드. 범위 = 이 머신 전체(모든 워크스페이스), 하루 = 서버 로컬 날짜.
   LLM_DAILY_BUDGET_TOKENS(정수 ≥ 0) 가 없거나 0 이면 꺼짐. 오늘 사용량(입력+출력)이
   예산 이상이면 lib/llm.ts tracked() 가 실제 호출을 막는다(캐시 적중은 영향 없음).
   사용량 조회는 30초 메모리 캐시 — 호출마다 DB 를 치지 않는다.
   ===================================================================== */

import { prisma } from "@/lib/prisma";
import { dayKey } from "@/lib/aiRoutes/relay";
import { log } from "@/lib/log";

export function dailyBudgetTokens(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.LLM_DAILY_BUDGET_TOKENS ?? "").trim();
  if (!/^\d+$/.test(raw)) return 0;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : 0;
}

export function isExceeded(usedToday: number, budget: number): boolean {
  return budget > 0 && usedToday >= budget;
}

const TTL_MS = 30_000;
let cache: { day: string; at: number; used: number } | null = null;

export function _resetBudgetCacheForTests(): void {
  cache = null;
}

/** 전 워크스페이스 LlmCall 중 오늘(서버 로컬 자정 이후) input+output 합. DB 에서 합산하므로 행 수 상한이 없다. */
export async function usedTokensToday(now: Date = new Date()): Promise<number> {
  const day = dayKey(now);
  if (cache && cache.day === day && now.getTime() - cache.at < TTL_MS && now.getTime() >= cache.at) return cache.used;
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const agg = await prisma.llmCall.aggregate({
    _sum: { inputTokens: true, outputTokens: true },
    where: { createdAt: { gte: midnight } },
  });
  const used = (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0);
  cache = { day, at: now.getTime(), used };
  return used;
}

let warnedUnenforceable = false;
export function _resetUnenforceableWarnForTests(): void {
  warnedUnenforceable = false;
}

/** 예산이 꺼져 있으면 DB 를 보지 않는다. 조회가 실패하면 통과시킨다(가드 때문에 기능이 죽으면 안 된다). */
export async function checkBudget(now: Date = new Date()): Promise<{ ok: boolean; used: number; budget: number }> {
  const budget = dailyBudgetTokens();
  if (budget <= 0) return { ok: true, used: 0, budget: 0 };
  if ((process.env.LLM_CALL_LOG || "").trim().toLowerCase() === "off") {
    // 기록이 없으면 셀 수 없다 — 조용히 0 으로 두지 말고 한 번 알린다.
    if (!warnedUnenforceable) {
      warnedUnenforceable = true;
      log.warn("llm.budget_unenforceable", { msg: "LLM_CALL_LOG=off 이라 예산을 셀 수 없습니다", budget });
    }
    return { ok: true, used: 0, budget };
  }
  // 집계 실패 시 fail-open: 예산 확인이 장애면 AI 기능 전체를 막기보다 통과시키고 경고만 남긴다.
  const used = await usedTokensToday(now).catch((e: unknown) => {
    log.warn("llm.budget_check_failed", { msg: "LLM 예산 집계 실패 — 통과시킴(fail-open)", err: e });
    return 0;
  });
  return { ok: !isExceeded(used, budget), used, budget };
}
