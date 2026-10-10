import { describe, expect, it, vi } from "vitest";
import { fetchWithRetry, parseRetryAfter, shouldRetry } from "./retryAfter";

describe("parseRetryAfter", () => {
  it("초 단위", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter(" 1.5 ")).toBe(1500);
  });
  it("10초 상한", () => expect(parseRetryAfter("120")).toBe(10_000));
  it("HTTP-date", () => {
    const now = Date.parse("2026-10-09T00:00:00Z");
    expect(parseRetryAfter("Fri, 09 Oct 2026 00:00:04 GMT", now)).toBe(4000);
    expect(parseRetryAfter("Fri, 09 Oct 2026 00:10:00 GMT", now)).toBe(10_000);
    expect(parseRetryAfter("Thu, 08 Oct 2026 00:00:00 GMT", now)).toBe(0);
  });
  it("없음·해석불가는 null", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter("-5")).toBeNull();
  });
});

const r429 = (ra: string) => new Response("slow down", { status: 429, headers: { "retry-after": ra } });

describe("shouldRetry", () => {
  it("남은 시간보다 500ms 이상 짧을 때만", () => {
    expect(shouldRetry(null, 10_000)).toBe(false);
    expect(shouldRetry(1000, null)).toBe(true);
    expect(shouldRetry(1000, 1500)).toBe(false);
    expect(shouldRetry(1000, 1501)).toBe(true);
  });
});

describe("fetchWithRetry", () => {
  it("429 한 번 → 200 이면 재시도 성공", async () => {
    const f = vi.fn().mockResolvedValueOnce(r429("1")).mockResolvedValueOnce(new Response("ok"));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();
    const { res } = await fetchWithRetry(f, { timeoutMs: 10_000, sleep, onRetry });
    expect(res.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(onRetry).toHaveBeenCalledWith(1000);
  });
  it("429 두 번이면 두 번째 429 를 그대로 돌려준다(한 번만 재시도)", async () => {
    const f = vi.fn().mockResolvedValueOnce(r429("1")).mockResolvedValueOnce(r429("1"));
    const { res } = await fetchWithRetry(f, { sleep: async () => {} });
    expect(res.status).toBe(429);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("Retry-After 가 남은 timeout 을 넘으면 재시도 없이 429", async () => {
    const f = vi.fn().mockResolvedValue(r429("8"));
    const sleep = vi.fn();
    const { res } = await fetchWithRetry(f, { timeoutMs: 5000, sleep });
    expect(res.status).toBe(429);
    expect(f).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
  it("Retry-After 없으면 재시도 안 함", async () => {
    const f = vi.fn().mockResolvedValue(new Response("x", { status: 429 }));
    await fetchWithRetry(f, {});
    expect(f).toHaveBeenCalledTimes(1);
  });
});
