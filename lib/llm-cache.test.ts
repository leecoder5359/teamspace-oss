import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// lib/llm.ts 의 기능별 모델 라우팅·max_tokens 와 응답 캐시 경로(A-5).
// 캐시 저장소는 메모리 Map 으로 바꾸고 키 계산(cacheKey)·켜짐 판정(cacheEnabled)은 실제 것을 쓴다.
const record = vi.fn();
vi.mock("@/lib/aiRoutes/llmCalls", () => ({ recordLlmCall: (r: unknown) => record(r) }));
const store = new Map<string, { text: string; model: string; feature: string }>();
vi.mock("@/lib/llmCache", async (orig) => {
  const real = await orig<typeof import("@/lib/llmCache")>();
  return {
    ...real,
    getCached: async (key: string) => {
      const v = store.get(key);
      return v ? { text: v.text, model: v.model } : null;
    },
    putCached: async (r: { key: string; feature: string; model: string; text: string }) => {
      store.set(r.key, { text: r.text, model: r.model, feature: r.feature });
    },
  };
});

import { complete, currentModel, currentModels, synthesizeAnswer } from "@/lib/llm";

const ENV_KEYS = ["ASK_LLM_PROVIDER", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_MODEL_EXTRACT", "LLM_CACHE"] as const;
const saved: Record<string, string | undefined> = {};
const ok = (text: string) => new Response(JSON.stringify({ content: [{ type: "text", text }], usage: { input_tokens: 4, output_tokens: 2 } }), { status: 200 });

let fetchMock: ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>;

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.ASK_LLM_PROVIDER = "api";
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.ANTHROPIC_MODEL = "synth-model";
  process.env.ANTHROPIC_MODEL_EXTRACT = "extract-model";
  delete process.env.LLM_CACHE;
  record.mockReset();
  store.clear();
  fetchMock = vi.fn(async () => ok("답"));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

const body = (i: number) => JSON.parse(String(fetchMock.mock.calls[i][1].body)) as { model: string; max_tokens: number };

describe("기능별 모델·max_tokens", () => {
  it("추출 기능은 추출 모델과 기능별 상한을 쓴다", async () => {
    await complete("p", { feature: "feedback-classify" });
    expect(body(0)).toMatchObject({ model: "extract-model", max_tokens: 600 });
  });
  it("ask(synthesizeAnswer)는 합성 모델·700", async () => {
    await synthesizeAnswer("q", [{ title: "t", heading: null, passage: "p" } as never]);
    expect(body(0)).toMatchObject({ model: "synth-model", max_tokens: 700 });
  });
  it("feature 없는 complete 는 추출·1500", async () => {
    await complete("p");
    expect(body(0)).toMatchObject({ model: "extract-model", max_tokens: 1500 });
  });
  it("currentModel 은 합성 모델, currentModels 는 둘 다", () => {
    expect(currentModel()).toBe("synth-model");
    expect(currentModels()).toEqual({ synthesize: "synth-model", extract: "extract-model" });
    process.env.ASK_LLM_PROVIDER = "off";
    expect(currentModels()).toBeNull();
  });
});

describe("응답 캐시", () => {
  it("두 번째 같은 호출은 fetch 0회 + provider=cache 기록 1행", async () => {
    expect(await complete("같은 프롬프트", { feature: "qa-extract", workspaceId: "ws1" })).toBe("답");
    expect(await complete("같은 프롬프트", { feature: "qa-extract", workspaceId: "ws1" })).toBe("답");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(2);
    const cacheRows = record.mock.calls.map((c) => c[0] as Record<string, unknown>).filter((r) => r.provider === "cache");
    expect(cacheRows).toHaveLength(1);
    expect(cacheRows[0]).toMatchObject({ feature: "qa-extract", workspaceId: "ws1", ok: true, durationMs: 0, inputTokens: null, outputTokens: null, model: "extract-model" });
  });

  it("system 이 다르면 다른 키", async () => {
    await complete("p", { system: "A" });
    await complete("p", { system: "B" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cache:false 는 읽지도 쓰지도 않는다", async () => {
    await complete("p", { cache: false });
    expect(store.size).toBe(0);
    await complete("p");
    await complete("p", { cache: false });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("LLM_CACHE=off 면 캐시 경로를 건너뛴다", async () => {
    process.env.LLM_CACHE = "off";
    await complete("p");
    await complete("p");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.size).toBe(0);
  });

  it("실패는 캐시하지 않는다", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("x", { status: 500 }));
    expect(await complete("p")).toBeNull();
    expect(store.size).toBe(0);
    expect(await complete("p")).toBe("답");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("synthesizeAnswer 도 같은 경로로 캐시된다", async () => {
    const src = [{ title: "t", heading: null, passage: "p" } as never];
    await synthesizeAnswer("q", src);
    await synthesizeAnswer("q", src);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[1][0]).toMatchObject({ provider: "cache", feature: "ask" });
  });
});

describe("잘린 응답·캐시 경로 방어", () => {
  const truncated = () => new Response(JSON.stringify({ content: [{ type: "text", text: "잘린" }], stop_reason: "max_tokens", usage: { input_tokens: 4, output_tokens: 2 } }), { status: 200 });
  it("max_tokens 로 잘린 응답은 돌려주되 캐시하지 않는다(두 번째 호출도 fetch)", async () => {
    fetchMock.mockImplementation(async () => truncated());
    expect(await complete("p", { feature: "feedback-classify" })).toBe("잘린");
    expect(store.size).toBe(0);
    expect(await complete("p", { feature: "feedback-classify" })).toBe("잘린");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("end_turn 응답은 캐시한다", async () => {
    await complete("p", { feature: "feedback-classify" });
    expect(store.size).toBe(1);
  });
});
