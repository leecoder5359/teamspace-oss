import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { cacheEnabled, cacheKey, deleteLlmCacheForWorkspace, getCached, LLM_CACHE_RETENTION_DAYS, purgeOldLlmCache, putCached } from "@/lib/llmCache";
import { prisma } from "@/lib/prisma";

// Next 가 ProcessEnv 에 NODE_ENV 를 필수로 넣어 둬서 테스트용 env 리터럴은 캐스트한다.
const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("cacheKey", () => {
  const base = { provider: "api", model: "m", prompt: "p" };
  it("결정적 sha256 hex", () => {
    const k = cacheKey(base);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheKey({ ...base })).toBe(k);
  });
  it("provider·model·system·prompt 중 하나라도 다르면 다른 키", () => {
    const k = cacheKey(base);
    expect(cacheKey({ ...base, provider: "cli" })).not.toBe(k);
    expect(cacheKey({ ...base, model: "m2" })).not.toBe(k);
    expect(cacheKey({ ...base, prompt: "p2" })).not.toBe(k);
    expect(cacheKey({ ...base, system: "S" })).not.toBe(k);
  });
  it("구분자 덕에 경계 이동이 충돌하지 않는다", () => {
    expect(cacheKey({ provider: "api", model: "m", system: "ab", prompt: "c" })).not.toBe(cacheKey({ provider: "api", model: "m", system: "a", prompt: "bc" }));
  });
});

describe("cacheEnabled", () => {
  it("LLM_CACHE=off 일 때만 꺼진다", () => {
    expect(cacheEnabled(env({}))).toBe(true);
    expect(cacheEnabled(env({ LLM_CACHE: "on" }))).toBe(true);
    expect(cacheEnabled(env({ LLM_CACHE: "off" }))).toBe(false);
    expect(cacheEnabled(env({ LLM_CACHE: " OFF " }))).toBe(false);
  });
});

describe("DB put/get/purge", () => {
  const keyA = cacheKey({ provider: "api", model: "m", prompt: `llmCache-test-${Date.now()}` });
  beforeEach(async () => {
    await prisma.llmCache.deleteMany({ where: { feature: "llmcache-test" } });
  });
  afterAll(async () => {
    await prisma.llmCache.deleteMany({ where: { feature: "llmcache-test" } });
  });

  it("miss 는 null, put 뒤 hit, 같은 키 put 은 덮어쓴다(upsert)", async () => {
    expect(await getCached(keyA)).toBeNull();
    await putCached({ key: keyA, feature: "llmcache-test", model: "m-1", text: "첫 답" });
    expect(await getCached(keyA)).toEqual({ text: "첫 답", model: "m-1" });
    await putCached({ key: keyA, feature: "llmcache-test", model: "m-2", text: "둘째 답" });
    expect(await getCached(keyA)).toEqual({ text: "둘째 답", model: "m-2" });
    expect(await prisma.llmCache.count({ where: { key: keyA } })).toBe(1);
  });

  it("hit 이면 lastHitAt 이 갱신된다", async () => {
    await putCached({ key: keyA, feature: "llmcache-test", model: "m", text: "t" });
    const old = new Date(Date.now() - 10 * 86_400_000);
    await prisma.llmCache.update({ where: { key: keyA }, data: { lastHitAt: old } });
    await getCached(keyA);
    // 갱신은 fire-and-forget — 잠깐 기다린 뒤 확인
    for (let i = 0; i < 20; i++) {
      const row = await prisma.llmCache.findUnique({ where: { key: keyA } });
      if (row && row.lastHitAt > old) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("lastHitAt 갱신 안 됨");
  });

  it("purge 는 마지막 적중이 보존 기간보다 오래된 행만 지운다", async () => {
    const keyB = cacheKey({ provider: "api", model: "m", prompt: `${keyA}-b` });
    await putCached({ key: keyA, feature: "llmcache-test", model: "m", text: "old" });
    await putCached({ key: keyB, feature: "llmcache-test", model: "m", text: "fresh" });
    const now = new Date();
    await prisma.llmCache.update({ where: { key: keyA }, data: { lastHitAt: new Date(now.getTime() - (LLM_CACHE_RETENTION_DAYS + 1) * 86_400_000) } });
    expect(await purgeOldLlmCache(now)).toBeGreaterThanOrEqual(1);
    expect(await getCached(keyA)).toBeNull();
    expect(await getCached(keyB)).toEqual({ text: "fresh", model: "m" });
  });

  it("workspaceId 는 키에 섞이고(워크스페이스 간 분리), 없으면 구 키와 같다", () => {
    const base = { provider: "api", model: "m", prompt: "p" };
    expect(cacheKey({ ...base, workspaceId: null })).toBe(cacheKey(base));
    expect(cacheKey({ ...base, workspaceId: "w1" })).not.toBe(cacheKey(base));
    expect(cacheKey({ ...base, workspaceId: "w1" })).not.toBe(cacheKey({ ...base, workspaceId: "w2" }));
  });

  it("put 은 workspaceId 를 저장하고, deleteLlmCacheForWorkspace 는 그 워크스페이스 행만 지운다", async () => {
    const k1 = cacheKey({ provider: "api", model: "m", prompt: `${keyA}-w`, workspaceId: "llmcache-ws-1" });
    const k2 = cacheKey({ provider: "api", model: "m", prompt: `${keyA}-w`, workspaceId: "llmcache-ws-2" });
    await putCached({ key: k1, feature: "llmcache-test", model: "m", text: "a", workspaceId: "llmcache-ws-1" });
    await putCached({ key: k2, feature: "llmcache-test", model: "m", text: "b", workspaceId: "llmcache-ws-2" });
    expect((await prisma.llmCache.findUnique({ where: { key: k1 } }))?.workspaceId).toBe("llmcache-ws-1");
    expect(await deleteLlmCacheForWorkspace("llmcache-ws-1")).toBe(1);
    expect(await getCached(k1)).toBeNull();
    expect(await getCached(k2)).toEqual({ text: "b", model: "m" });
  });

  it("put 실패는 삼킨다", async () => {
    await expect(putCached({ key: keyA, feature: "llmcache-test", model: "m", text: "x".repeat(10) + "\u0000" })).resolves.toBeUndefined();
  });
});
