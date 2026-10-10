import { describe, expect, it } from "vitest";
import { policyFor } from "./rateLimitPolicy";

describe("policyFor", () => {
  it("로그인 signin·callback 은 ip 키 20/60s", () => {
    for (const p of ["/api/auth/signin", "/api/auth/signin/google", "/api/auth/callback/google"]) {
      expect(policyFor(p, "POST")).toEqual({ name: "auth", limit: 20, windowMs: 60_000, key: "ip" });
      expect(policyFor(p, "GET")?.name).toBe("auth");
    }
  });

  it("세션 조회 등 다른 /api/auth 경로는 정책 없음(UI 가 자주 부름)", () => {
    expect(policyFor("/api/auth/session", "GET")).toBeNull();
    expect(policyFor("/api/auth/csrf", "GET")).toBeNull();
    expect(policyFor("/api/auth/providers", "GET")).toBeNull();
    expect(policyFor("/api/auth/signout", "POST")).toBeNull();
  });

  it("ask 는 10/60s, 클라이언트 키", () => {
    expect(policyFor("/api/ask", "POST")).toEqual({ name: "ask", limit: 10, windowMs: 60_000, key: "client" });
    expect(policyFor("/api/ask/stream", "POST")?.name).toBe("ask");
  });

  it("search 는 하위 경로 포함 60/60s", () => {
    for (const p of ["/api/search", "/api/search/concept", "/api/search/similar"]) {
      expect(policyFor(p, "GET")).toEqual({ name: "search", limit: 60, windowMs: 60_000, key: "client" });
    }
  });

  it("세그먼트 경계를 지킨다 — 접두만 같은 다른 경로는 제외", () => {
    expect(policyFor("/api/asker", "POST")).toBeNull();
    expect(policyFor("/api/searches", "GET")).toBeNull();
    expect(policyFor("/api/auth/signinx", "GET")).toBeNull();
  });

  it("site-intake 는 POST 만 viewer 키(사이트·게스트별) 10/60s", () => {
    expect(policyFor("/api/site-intake", "POST")).toEqual({ name: "site-intake", limit: 10, windowMs: 60_000, key: "viewer" });
    expect(policyFor("/api/site-intake", "post")?.name).toBe("site-intake");
    expect(policyFor("/api/site-intake", "GET")).toBeNull();
  });

  it("pair 폴링은 GET 만 코드별 60/60s + IP 합산 240/60s", () => {
    expect(policyFor("/api/pair/ABC123", "GET")).toEqual({
      name: "pair",
      limit: 60,
      windowMs: 60_000,
      key: "pair",
      also: { name: "pair-ip", limit: 240, windowMs: 60_000, key: "ip" },
    });
    expect(policyFor("/api/pair/ABC123/route-rule", "GET")?.name).toBe("pair");
    expect(policyFor("/api/pair/ABC123/route-rule", "POST")).toBeNull();
    expect(policyFor("/api/pair", "GET")).toBeNull();
  });

  it("그 외 경로·/pub·정적 자산은 null", () => {
    for (const p of ["/api/tasks", "/api/health", "/pub/tok/index.html", "/", "/setup.sh", "/p/x"]) {
      expect(policyFor(p, "GET")).toBeNull();
    }
  });
});

describe("policyFor — csp", () => {
  it("csp-report 는 POST 만 ip 키 1/60s", () => {
    expect(policyFor("/api/csp-report", "POST")).toEqual({ name: "csp", limit: 1, windowMs: 60_000, key: "ip" });
    expect(policyFor("/api/csp-report", "GET")).toBeNull();
  });
});
