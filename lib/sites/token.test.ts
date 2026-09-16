import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { signSiteToken, verifySiteToken, SITE_TOKEN_TTL_MS } from "./token";

describe("site token", () => {
  beforeEach(() => vi.stubEnv("AUTH_SECRET", "test-secret-a"));
  afterEach(() => vi.unstubAllEnvs());
  const base = { siteId: "cs1", version: 3, email: "g@gmail.com" };
  const now = 1_700_000_000_000;

  it("서명한 토큰을 그대로 되읽는다", () => {
    const t = signSiteToken(base, now);
    expect(verifySiteToken(t, now + 1000)).toEqual({ ...base, exp: now + SITE_TOKEN_TTL_MS });
  });

  it("URL 경로 세그먼트에 안전한 문자만 쓴다", () => {
    expect(signSiteToken(base, now)).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("만료되면 null", () => {
    const t = signSiteToken(base, now);
    expect(verifySiteToken(t, now + SITE_TOKEN_TTL_MS + 1)).toBeNull();
  });

  it("본문을 바꾸면 null (다른 사이트·버전으로 재사용 불가)", () => {
    const t = signSiteToken(base, now);
    const [, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ s: "other", v: 3, e: base.email, x: now + SITE_TOKEN_TTL_MS })).toString("base64url");
    expect(verifySiteToken(`${forged}.${sig}`, now)).toBeNull();
  });

  it("서명 1글자 변조·형식 불량은 null", () => {
    const t = signSiteToken(base, now);
    const flipped = t.slice(0, -1) + (t.endsWith("A") ? "B" : "A");
    expect(verifySiteToken(flipped, now)).toBeNull();
    expect(verifySiteToken("garbage", now)).toBeNull();
    expect(verifySiteToken("a.b.c", now)).toBeNull();
  });

  it("다른 AUTH_SECRET 로 만든 토큰은 null", () => {
    const t = signSiteToken(base, now);
    vi.stubEnv("AUTH_SECRET", "test-secret-b");
    expect(verifySiteToken(t, now)).toBeNull();
  });
});
