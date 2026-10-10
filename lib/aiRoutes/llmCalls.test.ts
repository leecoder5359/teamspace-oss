import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
const deleteMany = vi.fn(async () => ({ count: 0 }));
const findMany = vi.fn(async () => []);
vi.mock("@/lib/prisma", () => ({ prisma: { llmCall: { create: (...a: unknown[]) => create(...a), deleteMany: (...a: unknown[]) => (deleteMany as (...x: unknown[]) => unknown)(...a), findMany: (...a: unknown[]) => (findMany as (...x: unknown[]) => unknown)(...a) } } }));

import { aggregateLlmCalls, getTeamspaceUsage, recordLlmCall, type LlmCallRow } from "./llmCalls";

const NOW = new Date("2026-10-08T12:00:00Z");
const row = (o: Partial<LlmCallRow>): LlmCallRow => ({
  feature: "ask",
  provider: "cli",
  model: "m",
  ok: true,
  errorKind: null,
  durationMs: 100,
  inputTokens: null,
  outputTokens: null,
  createdAt: new Date("2026-10-08T01:00:00Z"),
  ...o,
});

describe("aggregateLlmCalls", () => {
  const rows = [
    row({}),
    row({ feature: "clip", provider: "api", model: "s", inputTokens: 50, outputTokens: 5, durationMs: 300 }),
    row({ feature: "clip", ok: false, errorKind: "timeout", durationMs: 500 }),
    row({ createdAt: new Date("2026-09-01T00:00:00Z") }), // 기간 밖
  ];
  const u = aggregateLlmCalls(rows, { days: 7, now: NOW, tz: "Asia/Seoul" });

  it("기간 안만 합계", () => {
    expect(u.totals).toMatchObject({ calls: 3, ok: 2, failed: 1, inputTokens: 50, outputTokens: 5, avgMs: 300 });
    expect(u.totals.okRate).toBeCloseTo(2 / 3);
  });
  it("추정 비용 usd — 토큰·단가를 아는 행만 합산, 없으면 null", () => {
    const c = aggregateLlmCalls(
      [
        row({ model: "claude-haiku-4-5", inputTokens: 1_000_000, outputTokens: 100_000 }), // 1 + 0.5
        row({ model: "claude-sonnet-4-6", inputTokens: 100_000, outputTokens: 0 }), // 0.3
        row({ model: "claude-haiku-4-5" }), // 토큰 없음
        row({ feature: "x", model: "mystery", inputTokens: 5, outputTokens: 5 }), // 단가 모름
      ],
      { days: 7, now: NOW, tz: "Asia/Seoul" },
    );
    expect(c.totals.usd).toBeCloseTo(1.8);
    expect(c.byFeature.find((f) => f.feature === "x")?.usd).toBeNull();
    expect(c.byFeature.find((f) => f.feature === "ask")?.usd).toBeCloseTo(1.8);
    expect(c.byProvider.find((p) => p.provider === "cli")?.usd).toBeCloseTo(1.8);
    expect(c.byDay[6].usd).toBeCloseTo(1.8);
    expect(c.byDay[0].usd).toBeNull();
    expect(u.totals.usd).toBeNull(); // 위 공용 rows 는 토큰이 api 한 행(모델 s)뿐 — 단가 모름
  });
  it("기능별(호출 많은 순)·경로별·오류 종류", () => {
    expect(u.byFeature.map((f) => [f.feature, f.calls])).toEqual([["clip", 2], ["ask", 1]]);
    expect(u.byProvider.find((p) => p.provider === "api")).toMatchObject({ calls: 1, models: ["s"], inputTokens: 50 });
    expect(u.errorKinds).toEqual([{ errorKind: "timeout", count: 1 }]);
  });
  it("캐시 적중 행은 실제 호출 지표에서 빠지고 cacheHits 로만 센다(totals·byDay·byFeature·byProvider)", () => {
    const hits = [row({ provider: "cache", model: "h", durationMs: 0 }), row({ feature: "clip", provider: "cache", model: "h", durationMs: 0 })];
    const c = aggregateLlmCalls([...rows, ...hits], { days: 7, now: NOW, tz: "Asia/Seoul" });
    // 캐시 없는 집계와 실제 호출 지표가 같다 — 시간 0 이 평균·p95·성공률을 끌어내리지 않는다
    const { cacheHits, ...realTotals } = c.totals;
    const { cacheHits: base, ...baseTotals } = u.totals;
    expect(realTotals).toEqual(baseTotals);
    expect([cacheHits, base]).toEqual([2, 0]);
    expect(c.byDay[6]).toMatchObject({ calls: 3, cacheHits: 2, avgMs: 300 });
    expect(c.byDay[0]).toMatchObject({ calls: 0, cacheHits: 0 });
    expect(c.byFeature.map((f) => [f.feature, f.calls, f.cacheHits])).toEqual([["clip", 2, 1], ["ask", 1, 1]]);
    expect(c.byProvider.find((p) => p.provider === "cache")).toMatchObject({ calls: 0, ok: 0, failed: 0, avgMs: null, cacheHits: 2, models: ["h"] });
    expect(c.byProvider.find((p) => p.provider === "cli")).toMatchObject({ calls: 2, cacheHits: 0 });
  });

  it("캐시 적중만 있는 기능도 목록에 남는다(calls 0, cacheHits n)", () => {
    const c = aggregateLlmCalls([row({ feature: "graph-infer", provider: "cache", durationMs: 0 })], { days: 7, now: NOW, tz: "Asia/Seoul" });
    expect(c.byFeature).toEqual([expect.objectContaining({ feature: "graph-infer", calls: 0, cacheHits: 1, avgMs: null, p95Ms: null, usd: null })]);
    expect(c.totals).toMatchObject({ calls: 0, cacheHits: 1, okRate: null });
  });
  it("일별 버킷은 빈 날 포함 7개", () => {
    expect(u.byDay).toHaveLength(7);
    expect(u.byDay[6]).toMatchObject({ day: "2026-10-08", calls: 3 });
  });
});

describe("recordLlmCall", () => {
  beforeEach(() => {
    create.mockReset();
    delete process.env.LLM_CALL_LOG;
  });
  it("메타만 저장한다(본문 필드 없음)", async () => {
    create.mockResolvedValue({});
    await recordLlmCall({ workspaceId: "w", feature: "ask", provider: "api", model: "s", ok: true, durationMs: 12.6, inputTokens: 3, outputTokens: 4 });
    expect(create).toHaveBeenCalledWith({
      data: { workspaceId: "w", feature: "ask", provider: "api", model: "s", ok: true, errorKind: null, durationMs: 13, inputTokens: 3, outputTokens: 4 },
    });
  });
  it("DB 오류·동기 throw 모두 삼킨다", async () => {
    create.mockRejectedValue(new Error("db down"));
    await expect(recordLlmCall({ feature: "x", provider: "cli", model: "m", ok: false, durationMs: 1 })).resolves.toBeUndefined();
    create.mockImplementation(() => {
      throw new Error("sync");
    });
    await expect(recordLlmCall({ feature: "x", provider: "cli", model: "m", ok: false, durationMs: 1 })).resolves.toBeUndefined();
  });
  it("캐시 적중(provider cache)도 같은 모양으로 남는다", async () => {
    create.mockResolvedValue({});
    await recordLlmCall({ workspaceId: "w", feature: "qa-extract", provider: "cache", model: "h", ok: true, durationMs: 0, inputTokens: null, outputTokens: null });
    expect(create.mock.calls[0][0].data).toMatchObject({ provider: "cache", durationMs: 0, inputTokens: null, outputTokens: null });
  });
  it("LLM_CALL_LOG=off 면 기록 안 함", async () => {
    process.env.LLM_CALL_LOG = "off";
    await recordLlmCall({ feature: "x", provider: "cli", model: "m", ok: true, durationMs: 1 });
    expect(create).not.toHaveBeenCalled();
  });
});

describe("getTeamspaceUsage purge 옵션", () => {
  beforeEach(() => { deleteMany.mockClear(); findMany.mockClear(); });
  it("기본은 보존 기간 지난 행을 정리한다", async () => {
    await getTeamspaceUsage("w1", 1, { now: NOW });
    expect(deleteMany).toHaveBeenCalledTimes(1);
  });
  it("purge:false 면 읽기만 하고 삭제하지 않는다", async () => {
    await getTeamspaceUsage("w1", 1, { now: NOW, purge: false });
    expect(deleteMany).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
