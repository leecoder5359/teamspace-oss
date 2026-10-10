import { isExceeded } from "@/lib/llmBudget";

/**
 * 오늘 AI 비용 블록 — /api/ai-routes 의 cost 와 /api/ops/status 의 llm 이 같은 계산을 쓴다.
 * todayTokens 가 null 이면 사용량 조회 실패("모름") — 0 으로 보이면 예산 소진 여부를 오판하므로 exceeded 는 false 로 두고 화면은 —.
 * todayUsd 는 이 워크스페이스의 오늘 추정 $ (byDay 에 오늘이 없거나 모르면 null).
 */
export function buildTodayCost(
  todayTokens: number | null,
  budgetTokens: number,
  byDay: { day: string; usd?: number | null }[],
  today: string,
): { todayTokens: number | null; todayUsd: number | null; budgetTokens: number; exceeded: boolean } {
  return {
    todayTokens,
    todayUsd: byDay.find((d) => d.day === today)?.usd ?? null,
    budgetTokens,
    exceeded: todayTokens === null ? false : isExceeded(todayTokens, budgetTokens),
  };
}
