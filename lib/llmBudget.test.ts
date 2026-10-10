import { beforeEach, describe, expect, it, vi } from "vitest";

const aggregate = vi.fn();
vi.mock("@/lib/prisma", () => ({ prisma: { llmCall: { aggregate: (...a: unknown[]) => aggregate(...a) } } }));

import { _resetBudgetCacheForTests, _resetUnenforceableWarnForTests, checkBudget, dailyBudgetTokens, isExceeded, usedTokensToday } from "./llmBudget";

describe("dailyBudgetTokens", () => {
  it("정수만 받고 없거나 잘못되면 0(끔)", () => {
    expect(dailyBudgetTokens({ LLM_DAILY_BUDGET_TOKENS: "500000" })).toBe(500000);
    expect(dailyBudgetTokens({ LLM_DAILY_BUDGET_TOKENS: " 12 " })).toBe(12);
    expect(dailyBudgetTokens({ LLM_DAILY_BUDGET_TOKENS: "0" })).toBe(0);
    expect(dailyBudgetTokens({ LLM_DAILY_BUDGET_TOKENS: "-5" })).toBe(0);
    expect(dailyBudgetTokens({ LLM_DAILY_BUDGET_TOKENS: "1.5" })).toBe(0);
    expect(dailyBudgetTokens({ LLM_DAILY_BUDGET_TOKENS: "abc" })).toBe(0);
    expect(dailyBudgetTokens({})).toBe(0);
  });
});

describe("isExceeded", () => {
  it("예산이 0 이면 항상 false, 같거나 넘으면 true", () => {
    expect(isExceeded(10, 0)).toBe(false);
    expect(isExceeded(99, 100)).toBe(false);
    expect(isExceeded(100, 100)).toBe(true);
    expect(isExceeded(101, 100)).toBe(true);
  });
});

describe("usedTokensToday", () => {
  const NOW = new Date(2026, 9, 9, 12, 0, 0); // 로컬 정오
  beforeEach(() => {
    _resetBudgetCacheForTests();
    aggregate.mockReset();
    _resetUnenforceableWarnForTests();
    delete process.env.LLM_CALL_LOG;
    delete process.env.LLM_DAILY_BUDGET_TOKENS;
  });

  it("DB 합산(aggregate)을 로컬 자정 기준으로 부르고 30초 캐시한다", async () => {
    aggregate.mockResolvedValue({ _sum: { inputTokens: 100, outputTokens: 25 } });
    expect(await usedTokensToday(NOW)).toBe(125);
    expect(aggregate.mock.calls[0][0]).toEqual({
      _sum: { inputTokens: true, outputTokens: true },
      where: { createdAt: { gte: new Date(2026, 9, 9, 0, 0, 0) } },
    });
    expect(await usedTokensToday(new Date(NOW.getTime() + 10_000))).toBe(125);
    expect(aggregate).toHaveBeenCalledTimes(1);
    expect(await usedTokensToday(new Date(NOW.getTime() + 31_000))).toBe(125);
    expect(aggregate).toHaveBeenCalledTimes(2);
  });

  it("합이 null(행 없음)이면 0", async () => {
    aggregate.mockResolvedValue({ _sum: { inputTokens: null, outputTokens: null } });
    expect(await usedTokensToday(NOW)).toBe(0);
  });

  it("checkBudget — 꺼져 있으면 DB 를 보지 않고, 켜져 있으면 초과를 판정", async () => {
    expect(await checkBudget(NOW)).toEqual({ ok: true, used: 0, budget: 0 });
    expect(aggregate).not.toHaveBeenCalled();
    process.env.LLM_DAILY_BUDGET_TOKENS = "100";
    aggregate.mockResolvedValue({ _sum: { inputTokens: 90, outputTokens: 10 } });
    expect(await checkBudget(NOW)).toEqual({ ok: false, used: 100, budget: 100 });
  });

  it("조회 실패는 통과(가드가 기능을 죽이지 않는다)", async () => {
    process.env.LLM_DAILY_BUDGET_TOKENS = "100";
    aggregate.mockRejectedValue(new Error("db"));
    expect((await checkBudget(NOW)).ok).toBe(true);
  });

  it("LLM_CALL_LOG=off — 예산을 셀 수 없어 통과시키고 경고는 프로세스당 한 번", async () => {
    process.env.LLM_DAILY_BUDGET_TOKENS = "100";
    process.env.LLM_CALL_LOG = "off";
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined); // log.warn → stderr
    expect(await checkBudget(NOW)).toEqual({ ok: true, used: 0, budget: 100 });
    expect(await checkBudget(NOW)).toEqual({ ok: true, used: 0, budget: 100 });
    expect(aggregate).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("llm.budget_unenforceable"))).toHaveLength(1);
    warn.mockRestore();
  });
});
