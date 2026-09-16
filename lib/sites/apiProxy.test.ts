import { describe, it, expect } from "vitest";
import {
  apiPathSegments,
  buildUpstreamUrl,
  isApiPath,
  normalizeApiUpstream,
  parseApiUpstreamInput,
  proxyResponseHeaders,
  siteApiTimeoutMs,
  upstreamRequestHeaders,
} from "./apiProxy";

describe("normalizeApiUpstream — 루프백만", () => {
  it.each([
    ["http://127.0.0.1:4717", "http://127.0.0.1:4717"],
    ["http://127.0.0.1:4717/", "http://127.0.0.1:4717"],
    ["  HTTP://LOCALHOST:8080  ", "http://localhost:8080"],
    ["http://[::1]:3000", "http://[::1]:3000"],
    ["https://127.0.0.1:443", "https://127.0.0.1:443"],
    ["http://127.0.0.1:1", "http://127.0.0.1:1"],
    ["http://127.0.0.1:65535", "http://127.0.0.1:65535"],
  ])("허용 %s → %s", (raw, want) => {
    expect(normalizeApiUpstream(raw)).toBe(want);
  });

  it.each([
    "http://127.0.0.1", // 포트 필수
    "http://127.0.0.1:0",
    "http://127.0.0.1:65536",
    "http://127.0.0.1:099",
    "http://127.0.0.1:4717/api", // 경로
    "http://127.0.0.1:4717//",
    "http://127.0.0.1:4717?x=1", // 쿼리
    "http://127.0.0.1:4717#h", // 해시
    "http://u:p@127.0.0.1:4717", // userinfo
    "http://127.0.0.1@evil.com:4717",
    "http://127.1:4717", // 우회 표기
    "http://0x7f.0.0.1:4717",
    "http://0.0.0.0:4717",
    "http://10.0.0.5:4717", // 사설망
    "http://169.254.169.254:80", // 메타데이터
    "http://example.com:80",
    "http://localhost.evil.com:80",
    "ftp://127.0.0.1:21",
    "127.0.0.1:4717",
    "",
  ])("거부 %s", (raw) => {
    expect(normalizeApiUpstream(raw)).toBeNull();
  });
});

describe("parseApiUpstreamInput", () => {
  it("null·빈 문자열 = 해제", () => {
    expect(parseApiUpstreamInput(null)).toEqual({ ok: true, value: null });
    expect(parseApiUpstreamInput("")).toEqual({ ok: true, value: null });
    expect(parseApiUpstreamInput("   ")).toEqual({ ok: true, value: null });
  });
  it("정규화해서 돌려준다", () => {
    expect(parseApiUpstreamInput("http://localhost:4717/")).toEqual({ ok: true, value: "http://localhost:4717" });
  });
  it("문자열이 아니거나 루프백이 아니면 오류", () => {
    expect(parseApiUpstreamInput(4717).ok).toBe(false);
    expect(parseApiUpstreamInput("http://10.0.0.1:80").ok).toBe(false);
  });
});

describe("경로", () => {
  it("isApiPath: 첫 세그먼트가 api", () => {
    expect(isApiPath(["api", "x"])).toBe(true);
    expect(isApiPath(["api"])).toBe(true);
    expect(isApiPath(["apis", "x"])).toBe(false);
    expect(isApiPath(["index.html"])).toBe(false);
    expect(isApiPath([])).toBe(false);
    expect(isApiPath(undefined)).toBe(false);
  });

  it("apiPathSegments: 디코드·검증", () => {
    expect(apiPathSegments(["api", "generate"])).toEqual(["api", "generate"]);
    expect(apiPathSegments(["api", "a%20b"])).toEqual(["api", "a b"]);
    for (const bad of [
      ["api", ".."],
      ["api", "%2e%2e"],
      ["api", "."],
      ["api", ""],
      ["api", "a\\b"],
      ["api", "a%5Cb"],
      ["api", "a%2Fb"],
      ["api", "a%00"],
      ["api", "%E0%A4%A"],
      ["x", "api"],
    ]) {
      expect(apiPathSegments(bad), bad.join("/")).toBeNull();
    }
  });

  it("buildUpstreamUrl: 세그먼트 재인코딩 + 쿼리", () => {
    expect(buildUpstreamUrl("http://127.0.0.1:4717", ["api", "generate"], "?a=1")).toBe("http://127.0.0.1:4717/api/generate?a=1");
    expect(buildUpstreamUrl("http://127.0.0.1:4717", ["api", "a?b#c"], "")).toBe("http://127.0.0.1:4717/api/a%3Fb%23c");
  });
});

describe("헤더", () => {
  it("content-type·accept 만 넘기고 판정 결과를 붙인다", () => {
    const h = upstreamRequestHeaders(
      new Headers({ "content-type": "application/json", accept: "application/json", cookie: "s=1", authorization: "Bearer x", host: "evil" }),
      { siteId: "cs1", email: "g@gmail.com", member: false },
    );
    expect(h).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      "x-teamspace-site-id": "cs1",
      "x-teamspace-viewer": "g@gmail.com",
      "x-teamspace-member": "false",
    });
  });

  it("응답 헤더: no-store·nosniff·no-referrer·CSP sandbox, allow-same-origin 없음", () => {
    const h = proxyResponseHeaders("application/json");
    expect(h["content-type"]).toBe("application/json");
    expect(h["cache-control"]).toBe("no-store");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("no-referrer");
    expect(h["content-security-policy"]).toMatch(/^sandbox /);
    expect(h["content-security-policy"]).not.toContain("allow-same-origin");
    expect(proxyResponseHeaders(null)["content-type"]).toBeUndefined();
  });
});

describe("siteApiTimeoutMs", () => {
  it("기본 600000, env 로 덮는다, 이상값은 기본", () => {
    expect(siteApiTimeoutMs({})).toBe(600_000);
    expect(siteApiTimeoutMs({ SITE_API_TIMEOUT_MS: "1500" })).toBe(1500);
    expect(siteApiTimeoutMs({ SITE_API_TIMEOUT_MS: "abc" })).toBe(600_000);
    expect(siteApiTimeoutMs({ SITE_API_TIMEOUT_MS: "0" })).toBe(600_000);
  });
});
