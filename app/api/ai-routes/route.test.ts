import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/aiRoutes/relay", () => ({
  clampDays: vi.fn(() => 7),
  getRelayReport: vi.fn(),
  dayKey: (d: Date) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(d),
}));
vi.mock("@/lib/aiRoutes/llmCalls", () => ({ getTeamspaceUsage: vi.fn() }));
vi.mock("@/lib/llmBudget", () => ({ dailyBudgetTokens: vi.fn(() => 1000), isExceeded: (u: number, b: number) => b > 0 && u >= b, usedTokensToday: vi.fn(async () => 1500) }));
vi.mock("@/lib/llm", () => ({ currentModels: vi.fn(() => ({ synthesize: "ms", extract: "me" })), resolveProvider: vi.fn(() => "cli") }));

import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { getRelayReport } from "@/lib/aiRoutes/relay";
import { getTeamspaceUsage } from "@/lib/aiRoutes/llmCalls";
import { usedTokensToday } from "@/lib/llmBudget";
import { GET } from "./route";

const m = (f: unknown) => f as Mock;
const agent = (role: string) => ({ workspaceId: "w1", userId: "a1", role, actor: { type: "agent", id: "a1", name: "bot" } });
const user = (role: string) => ({ workspaceId: "w1", userId: "u1", role, actor: { type: "user", id: "u1", name: "U" } });
const req = () => new Request("http://t/api/ai-routes?days=7");

describe("GET /api/ai-routes 권한", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m(getRelayReport).mockResolvedValue({ configured: false, label: "relay", status: null, usage: null, usageError: null });
    m(getTeamspaceUsage).mockResolvedValue({
      totals: {}, byDay: [], byFeature: [], errorKinds: [],
      byProvider: [{ provider: "cli", calls: 2, ok: 2, inputTokens: 30, outputTokens: 5 }],
    });
  });

  it("editor 이상을 요구한다(requireCtx 하한 = editor) — viewer 는 requireCtx 가 거절", async () => {
    m(requireCtx).mockResolvedValue({ err: NextResponse.json({}, { status: 403 }) });
    expect((await GET(req())).status).toBe(403);
    expect(requireCtx).toHaveBeenCalledWith("editor");
    expect(getTeamspaceUsage).not.toHaveBeenCalled();
  });

  it("editor 에이전트 토큰은 읽을 수 있다(CLI)", async () => {
    m(requireCtx).mockResolvedValue(agent("editor"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(m(getTeamspaceUsage).mock.calls[0][0]).toBe("w1");
    expect(m(getTeamspaceUsage).mock.calls[0][2]).toBeUndefined(); // 이 라우트는 기본(purge) 동작을 유지한다
  });

  it("editor 사람 세션은 403 — 사람은 여전히 관리자만", async () => {
    m(requireCtx).mockResolvedValue(user("editor"));
    expect((await GET(req())).status).toBe(403);
    expect(getTeamspaceUsage).not.toHaveBeenCalled();
    expect(getRelayReport).not.toHaveBeenCalled();
  });

  it("cli 경로 토큰: 기록된 행이 있으면 합계, 하나도 없으면 null", async () => {
    m(requireCtx).mockResolvedValue(agent("editor"));
    let body = await (await GET(req())).json();
    expect(body.routes).toEqual([expect.objectContaining({ kind: "cli", inputTokens: 30, outputTokens: 5 })]);
    m(getTeamspaceUsage).mockResolvedValue({
      totals: {}, byDay: [], byFeature: [], errorKinds: [],
      byProvider: [{ provider: "cli", calls: 2, ok: 2, inputTokens: 0, outputTokens: 0 }],
    });
    body = await (await GET(req())).json();
    expect(body.routes).toEqual([expect.objectContaining({ kind: "cli", inputTokens: null, outputTokens: null })]);
  });

  it("등급별 모델·캐시 적중 수를 싣고, 캐시 행은 routes 표에 넣지 않는다", async () => {
    m(requireCtx).mockResolvedValue(agent("editor"));
    m(getTeamspaceUsage).mockResolvedValue({
      totals: { calls: 2, cacheHits: 4 }, byDay: [], byFeature: [], errorKinds: [],
      byProvider: [
        { provider: "cli", calls: 2, ok: 2, inputTokens: 30, outputTokens: 5, cacheHits: 0 },
        { provider: "cache", calls: 0, ok: 0, inputTokens: 0, outputTokens: 0, cacheHits: 4 },
      ],
    });
    const body = await (await GET(req())).json();
    expect(body.teamspace.models).toEqual({ synthesize: "ms", extract: "me" });
    expect(body.teamspace.cacheHits).toBe(4); // = totals.cacheHits
    expect(body.cost.cacheHits).toBe(4);
    expect(body.teamspace).not.toHaveProperty("model");
    expect(body.routes.map((r: { kind: string }) => r.kind)).toEqual(["cli"]);
  });

  it("캐시 행이 없으면 cacheHits 0", async () => {
    m(requireCtx).mockResolvedValue(agent("editor"));
    expect((await (await GET(req())).json()).teamspace.cacheHits).toBe(0);
  });

  it("cost — 오늘 토큰·예산·초과·기간 $·캐시 적중을 싣는다", async () => {
    m(requireCtx).mockResolvedValue(agent("editor"));
    const today = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    m(getTeamspaceUsage).mockResolvedValue({
      totals: { usd: 1.25, cacheHits: 3 }, byDay: [{ day: "2000-01-01", usd: 9 }, { day: today, usd: 0.5 }], byFeature: [], errorKinds: [],
      byProvider: [{ provider: "cache", calls: 0, ok: 0, inputTokens: 0, outputTokens: 0, cacheHits: 3 }],
    });
    const body = await (await GET(req())).json();
    expect(body.cost).toEqual({ todayTokens: 1500, todayUsd: 0.5, periodUsd: 1.25, budgetTokens: 1000, exceeded: true, cacheHits: 3 });
    expect(body.relay).toBeDefined();
    expect(body.routes).toBeDefined();
  });

  it("cost — 오늘 토큰 조회가 실패하면 0 이 아니라 null(초과 아님)", async () => {
    m(requireCtx).mockResolvedValue(agent("editor"));
    m(getTeamspaceUsage).mockResolvedValue({ totals: { usd: null, cacheHits: 0 }, byDay: [], byFeature: [], errorKinds: [], byProvider: [] });
    m(usedTokensToday).mockRejectedValueOnce(new Error("db down"));
    const body = await (await GET(req())).json();
    expect(body.cost.todayTokens).toBeNull();
    expect(body.cost.exceeded).toBe(false);
  });

  it("admin 사람 세션은 허용", async () => {
    m(requireCtx).mockResolvedValue(user("admin"));
    expect((await GET(req())).status).toBe(200);
  });
});
