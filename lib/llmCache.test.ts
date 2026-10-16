import { beforeEach, describe, expect, it, vi } from "vitest";

/* llmCache 델리게이트 메모리 가짜 — 이 파일은 실제 DB 를 절대 건드리지 않는다(vitest 는 .env 를 읽지 않는다).
   lib/llmCache.ts 가 쓰는 메서드(findUnique·update·upsert·deleteMany)만, Prisma 의 where/select 모양 그대로 흉내 낸다.
   Postgres 가 text 의 NUL(\u0000) 을 거부하는 것도 흉내 내 'put 실패는 삼킨다' 를 같은 입력으로 확인한다. */
type Row = { key: string; workspaceId: string | null; feature: string; model: string; text: string; createdAt: Date; lastHitAt: Date };
const { rows, delegate } = vi.hoisted(() => {
  const rows = new Map<string, Row>();
  const pick = (r: Row, select?: Record<string, boolean>) =>
    select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, r[k as keyof Row]])) : { ...r };
  const rejectNul = (text: string) => {
    if (text.includes("\u0000")) throw new Error("invalid byte sequence for encoding \"UTF8\": 0x00");
  };
  const delegate = {
    findUnique: vi.fn(async ({ where, select }: { where: { key: string }; select?: Record<string, boolean> }) => {
      const r = rows.get(where.key);
      return r ? pick(r, select) : null;
    }),
    update: vi.fn(async ({ where, data }: { where: { key: string }; data: Partial<Row> }) => {
      const r = rows.get(where.key);
      if (!r) throw new Error("Record to update not found.");
      Object.assign(r, data);
      return { ...r };
    }),
    upsert: vi.fn(async ({ where, create, update }: { where: { key: string }; create: Omit<Row, "createdAt" | "lastHitAt">; update: Partial<Row> }) => {
      const r = rows.get(where.key);
      if (r) {
        if (update.text != null) rejectNul(update.text);
        Object.assign(r, update);
        return { ...r };
      }
      rejectNul(create.text);
      const now = new Date();
      const row: Row = { ...create, createdAt: now, lastHitAt: now };
      rows.set(row.key, row);
      return { ...row };
    }),
    deleteMany: vi.fn(async ({ where }: { where: { lastHitAt?: { lt: Date }; workspaceId?: string } }) => {
      let count = 0;
      for (const [k, r] of rows) {
        const byHit = where.lastHitAt ? r.lastHitAt < where.lastHitAt.lt : true;
        const byWs = where.workspaceId !== undefined ? r.workspaceId === where.workspaceId : true;
        if (byHit && byWs) {
          rows.delete(k);
          count++;
        }
      }
      return { count };
    }),
  };
  return { rows, delegate };
});
vi.mock("@/lib/prisma", () => ({ prisma: { llmCache: delegate } }));

import { cacheEnabled, cacheKey, deleteLlmCacheForWorkspace, getCached, LLM_CACHE_RETENTION_DAYS, purgeOldLlmCache, putCached } from "@/lib/llmCache";

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

describe("put/get/purge (prisma 메모리 가짜)", () => {
  const keyA = cacheKey({ provider: "api", model: "m", prompt: "llmCache-test" });
  beforeEach(() => {
    rows.clear();
    vi.clearAllMocks();
  });

  it("miss 는 null, put 뒤 hit, 같은 키 put 은 덮어쓴다(upsert)", async () => {
    expect(await getCached(keyA)).toBeNull();
    await putCached({ key: keyA, feature: "llmcache-test", model: "m-1", text: "첫 답" });
    expect(await getCached(keyA)).toEqual({ text: "첫 답", model: "m-1" });
    await putCached({ key: keyA, feature: "llmcache-test", model: "m-2", text: "둘째 답" });
    expect(await getCached(keyA)).toEqual({ text: "둘째 답", model: "m-2" });
    expect(rows.size).toBe(1);
  });

  it("hit 이면 lastHitAt 이 갱신된다", async () => {
    await putCached({ key: keyA, feature: "llmcache-test", model: "m", text: "t" });
    const old = new Date(Date.now() - 10 * 86_400_000);
    rows.get(keyA)!.lastHitAt = old;
    await getCached(keyA);
    // 갱신은 fire-and-forget — 한 틱 뒤 확인
    await new Promise((r) => setTimeout(r, 0));
    expect(rows.get(keyA)!.lastHitAt.getTime()).toBeGreaterThan(old.getTime());
  });

  it("hit 의 lastHitAt 갱신 실패는 새지 않는다", async () => {
    await putCached({ key: keyA, feature: "llmcache-test", model: "m", text: "t" });
    delegate.update.mockRejectedValueOnce(new Error("db down"));
    expect(await getCached(keyA)).toEqual({ text: "t", model: "m" });
    await new Promise((r) => setTimeout(r, 0));
  });

  it("get 실패는 miss(null)", async () => {
    delegate.findUnique.mockRejectedValueOnce(new Error("db down"));
    expect(await getCached(keyA)).toBeNull();
  });

  it("purge 는 마지막 적중이 보존 기간보다 오래된 행만 지운다", async () => {
    const keyB = cacheKey({ provider: "api", model: "m", prompt: `${keyA}-b` });
    await putCached({ key: keyA, feature: "llmcache-test", model: "m", text: "old" });
    await putCached({ key: keyB, feature: "llmcache-test", model: "m", text: "fresh" });
    const now = new Date();
    rows.get(keyA)!.lastHitAt = new Date(now.getTime() - (LLM_CACHE_RETENTION_DAYS + 1) * 86_400_000);
    expect(await purgeOldLlmCache(now)).toBe(1);
    expect(delegate.deleteMany).toHaveBeenCalledWith({ where: { lastHitAt: { lt: new Date(now.getTime() - LLM_CACHE_RETENTION_DAYS * 86_400_000) } } });
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
    expect(rows.get(k1)?.workspaceId).toBe("llmcache-ws-1");
    expect(await deleteLlmCacheForWorkspace("llmcache-ws-1")).toBe(1);
    expect(await getCached(k1)).toBeNull();
    expect(await getCached(k2)).toEqual({ text: "b", model: "m" });
  });

  it("put 실패는 삼킨다", async () => {
    await expect(putCached({ key: keyA, feature: "llmcache-test", model: "m", text: "x".repeat(10) + "\u0000" })).resolves.toBeUndefined();
    expect(delegate.upsert).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(0);
  });
});
