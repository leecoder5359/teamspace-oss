import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { clampDays, dayKey, getRelayReport } from "@/lib/aiRoutes/relay";
import { getTeamspaceUsage } from "@/lib/aiRoutes/llmCalls";
import { currentModels, resolveProvider } from "@/lib/llm";
import { dailyBudgetTokens, usedTokensToday } from "@/lib/llmBudget";
import { buildTodayCost } from "@/lib/llmCostBlock";

export const runtime = "nodejs";

const PROVIDER_ROUTE: Record<string, string> = { api: "TeamSpace → Anthropic API", cli: "TeamSpace → claude CLI" };

/**
 * GET /api/ai-routes?days=7 → AI 실행 경로(로그 메타라도 운영 정보).
 *   권한: 사람 로그인 세션은 admin, 에이전트 토큰은 editor 이상(CLI `pnpm ws ai-routes` 는 항상 에이전트 토큰).
 *   env 금고 "pull" 가드와 같은 하한. 화면(설정 › AI 실행 경로)은 여전히 관리자에게만 보인다.
 *   relay     외부 중계 서버 상태·사용량(AI_RELAY_* env, 비면 configured:false) — 머신 단위
 *   teamspace 이 워크스페이스의 LlmCall 집계(기능별·일별·경로별) + provider·models{synthesize,extract}(off 면 null)
 *             · cacheHits(기간 내 응답 캐시 적중 = provider "cache" 행 수)
 *   cost      AI 비용(추정) — todayTokens(머신 전체 오늘 입력+출력)·todayUsd(이 워크스페이스 오늘 추정 $, 모르면 null)·
 *             periodUsd(기간 합계 $)·budgetTokens(LLM_DAILY_BUDGET_TOKENS, 0=끔)·exceeded·cacheHits. 단가는 공개 단가 추정(lib/llmCost)
 *   routes    사용처 표 — 경로별 호출·토큰
 */
export async function GET(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  if (guard.actor.type === "user" && guard.role !== "admin") {
    return NextResponse.json({ error: "AI 실행 경로는 관리자만 볼 수 있습니다." }, { status: 403 });
  }
  const days = clampDays(new URL(request.url).searchParams.get("days"));

  const [relay, teamspace] = await Promise.all([getRelayReport(days), getTeamspaceUsage(guard.workspaceId, days)]);
  const provider = resolveProvider();

  const routes: { name: string; kind: "relay" | "api" | "cli"; calls: number; ok: number; inputTokens: number | null; outputTokens: number | null }[] = [];
  if (relay.configured && relay.usage) {
    const t = relay.usage.totals;
    routes.push({ name: relay.label, kind: "relay", calls: t.calls, ok: t.ok, inputTokens: t.inputTokens, outputTokens: t.outputTokens });
  }
  const seen = new Set<string>();
  for (const p of teamspace.byProvider) {
    if (p.provider !== "api" && p.provider !== "cli") continue;
    seen.add(p.provider);
    // cli 는 출력 형식을 json 으로 바꾸기 전 행엔 토큰이 없다(null). 기간 안에 토큰이 기록된 행이
    // 하나도 없으면(합계 0) 0 이 아니라 null 로 보내 "모름" 으로 표시한다.
    const known = p.provider === "api" || p.inputTokens + p.outputTokens > 0;
    routes.push({ name: PROVIDER_ROUTE[p.provider], kind: p.provider, calls: p.calls, ok: p.ok, inputTokens: known ? p.inputTokens : null, outputTokens: known ? p.outputTokens : null });
  }
  if (provider !== "off" && !seen.has(provider)) {
    routes.push({ name: PROVIDER_ROUTE[provider], kind: provider, calls: 0, ok: 0, inputTokens: 0, outputTokens: 0 });
  }

  // 집계(agg)가 캐시 적중을 calls 에서 빼고 cacheHits 로 따로 센다 — 상단 값은 totals 와 같은 수
  const cacheHits = teamspace.totals.cacheHits ?? 0;

  const budgetTokens = dailyBudgetTokens();
  const todayTokens = await usedTokensToday().catch(() => null as number | null); // 실패는 0 이 아니라 null("모름")
  const today = dayKey(new Date());
  const cost = {
    ...buildTodayCost(todayTokens, budgetTokens, teamspace.byDay, today),
    periodUsd: teamspace.totals.usd ?? null,
    cacheHits,
  };

  return NextResponse.json(
    { days, relay, teamspace: { ...teamspace, provider, models: currentModels(), cacheHits }, cost, routes },
    { headers: { "Cache-Control": "no-store" } },
  );
}
