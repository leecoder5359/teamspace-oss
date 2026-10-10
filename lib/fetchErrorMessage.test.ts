import { describe, expect, it } from "vitest";
import { fetchErrorMessage, responseErrorMessage } from "./fetchErrorMessage";

describe("fetchErrorMessage", () => {
  it("429 는 Retry-After 초를 넣어 안내", () => {
    expect(fetchErrorMessage(429, "12")).toBe("요청이 많아요. 12초 뒤 다시 시도해 주세요.");
  });
  it("헤더가 없으면 본문 retryAfterSec, 둘 다 없으면 '잠시 뒤'", () => {
    expect(fetchErrorMessage(429, null, { retryAfterSec: 3 })).toBe("요청이 많아요. 3초 뒤 다시 시도해 주세요.");
    expect(fetchErrorMessage(429, "abc")).toBe("요청이 많아요. 잠시 뒤 다시 시도해 주세요.");
  });
  it("그 밖의 오류는 짧은 실패 문구", () => {
    expect(fetchErrorMessage(500, null)).toBe("결과를 가져오지 못했어요. 잠시 뒤 다시 시도해 주세요.");
    expect(fetchErrorMessage(401, "5")).not.toContain("5초");
  });
});

describe("responseErrorMessage", () => {
  it("OK 면 null", () => {
    expect(responseErrorMessage(new Response("{}", { status: 200 }))).toBeNull();
  });
  it("429 응답 — 본문을 결과로 쓰지 않고 메시지만 돌려준다", () => {
    const r = new Response(JSON.stringify({ error: "rate_limited", retryAfterSec: 7 }), { status: 429, headers: { "Retry-After": "7" } });
    expect(responseErrorMessage(r)).toBe("요청이 많아요. 7초 뒤 다시 시도해 주세요.");
  });
});
