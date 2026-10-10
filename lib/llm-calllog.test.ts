import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// lib/llm.ts 가 호출마다 LlmCall 1행(메타만)을 남기는지 — fetch 를 가짜로 바꿔 api 경로로 검증.
const record = vi.fn();
vi.mock("@/lib/aiRoutes/llmCalls", () => ({ recordLlmCall: (r: unknown) => record(r) }));

const store = new Map<string, { text: string; model: string }>();
vi.mock("@/lib/llmCache", async (orig) => {
  const real = await orig<typeof import("@/lib/llmCache")>();
  return {
    ...real,
    getCached: async (key: string) => store.get(key) ?? null,
    putCached: async (r: { key: string; model: string; text: string }) => {
      store.set(r.key, { text: r.text, model: r.model });
    },
  };
});

const budget = vi.fn(async () => ({ ok: true, used: 0, budget: 0 }));
vi.mock("@/lib/llmBudget", () => ({ checkBudget: () => budget() }));

import { complete, synthesizeAnswer } from "@/lib/llm";

const ENV_KEYS = ["ASK_LLM_PROVIDER", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_MODEL_EXTRACT", "LLM_CACHE"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.ASK_LLM_PROVIDER = "api";
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.ANTHROPIC_MODEL = "claude-test";
  process.env.ANTHROPIC_MODEL_EXTRACT = "claude-test-extract";
  process.env.LLM_CACHE = "off"; // 캐시 경로는 lib/llm-cache.test.ts
  record.mockReset();
  store.clear();
  budget.mockReset();
  budget.mockResolvedValue({ ok: true, used: 0, budget: 0 });
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe("lib/llm 일일 예산", () => {
  it("초과 — fetch 0회 + budget_exceeded 행(모델은 쓰려던 것) + null, 로그는 하루 1번", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    budget.mockResolvedValue({ ok: false, used: 1200, budget: 1000 });
    expect(await complete("p", { feature: "qa-extract", workspaceId: "ws1" })).toBeNull();
    expect(await complete("p2", { feature: "qa-extract" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[0][0]).toMatchObject({ workspaceId: "ws1", feature: "qa-extract", provider: "api", model: "claude-test-extract", ok: false, errorKind: "budget_exceeded", durationMs: 0 });
    expect(err.mock.calls.filter((c) => String(c[0]).includes("예산"))).toHaveLength(1);
    expect(await complete("p3", { feature: "qa-extract" })).toBeNull();
    expect(err.mock.calls.filter((c) => String(c[0]).includes("예산"))).toHaveLength(1);
    err.mockRestore();
  });
});

describe("lib/llm 예산 × 캐시", () => {
  it("캐시 적중은 예산 초과여도 캐시 응답을 돌려주고 fetch 0회·budget_exceeded 행 없음", async () => {
    process.env.LLM_CACHE = "on";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "캐시답" }], usage: { input_tokens: 4, output_tokens: 2 } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    // 1) 예산 여유로 한 번 호출해 캐시에 저장
    expect(await complete("same", { feature: "qa-extract" })).toBe("캐시답");
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    record.mockReset();
    // 2) 초과 상태에서 같은 프롬프트
    budget.mockResolvedValue({ ok: false, used: 2000, budget: 1000 });
    expect(await complete("same", { feature: "qa-extract" })).toBe("캐시답");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(record.mock.calls.some((c) => (c[0] as { errorKind?: string }).errorKind === "budget_exceeded")).toBe(false);
  });
});

describe("lib/llm 호출 기록", () => {
  it("성공 — 기능·워크스페이스·모델·토큰(캐시 포함 입력)을 남기고 본문은 넘기지 않는다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ model: "claude-test-20261001", content: [{ type: "text", text: "답" }], usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 } }),
          { status: 200 },
        ),
      ),
    );
    const out = await complete("비밀 프롬프트", { feature: "qa-extract", workspaceId: "ws1" });
    expect(out).toBe("답");
    expect(record).toHaveBeenCalledTimes(1);
    const r = record.mock.calls[0][0] as Record<string, unknown>;
    expect(r).toMatchObject({ workspaceId: "ws1", feature: "qa-extract", provider: "api", model: "claude-test-20261001", ok: true, errorKind: null, inputTokens: 15, outputTokens: 3 });
    expect(typeof r.durationMs).toBe("number");
    expect(JSON.stringify(r)).not.toContain("비밀");
    expect(JSON.stringify(r)).not.toContain("답");
  });

  it("HTTP 실패 — null 반환, errorKind=http_<status>", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 429 })));
    expect(await synthesizeAnswer("q", [{ title: "t", heading: null, passage: "p" } as never], { workspaceId: "ws1" })).toBeNull();
    expect(record.mock.calls[0][0]).toMatchObject({ feature: "ask", provider: "api", ok: false, errorKind: "http_429", inputTokens: null });
  });

  it("네트워크 오류 — 기록은 하고 throw 하지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    expect(await complete("p")).toBeNull();
    expect(record.mock.calls[0][0]).toMatchObject({ feature: "complete", ok: false, errorKind: "network", workspaceId: null });
  });

  it("두 번째 인자가 문자열이면 system 으로 보낸다(기존 호출 호환)", async () => {
    const f = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    await complete("p", "SYS");
    expect(JSON.parse(String(f.mock.calls[0][1].body)).system).toBe("SYS");
    // feature 없는 complete 는 추출 등급 → ANTHROPIC_MODEL_EXTRACT
    expect(record.mock.calls[0][0]).toMatchObject({ model: "claude-test-extract", inputTokens: null, outputTokens: null });
  });

  it("off 면 호출도 기록도 없다", async () => {
    process.env.ASK_LLM_PROVIDER = "off";
    expect(await complete("p")).toBeNull();
    expect(record).not.toHaveBeenCalled();
  });
});
