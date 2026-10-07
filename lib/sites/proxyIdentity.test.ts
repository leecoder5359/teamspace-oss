import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  PROXY_MEMBER_HEADER,
  PROXY_SIG_HEADER,
  PROXY_SITE_HEADER,
  PROXY_VIEWER_HEADER,
  PROXY_SIG_TTL_MS,
  hasProxyIdentityHeaders,
  readProxyIdentity,
  signProxyIdentity,
  type ProxyBinding,
} from "./proxyIdentity";

const ID = { siteId: "cs1", email: "g@gmail.com", member: false };
const BIND: ProxyBinding = { method: "POST", path: "/api/site-intake", body: Buffer.from('{"items":[]}') };

function headers(over: Record<string, string> = {}, bind: ProxyBinding = BIND, now = Date.now()): Headers {
  return new Headers({
    [PROXY_SITE_HEADER]: ID.siteId,
    [PROXY_VIEWER_HEADER]: ID.email,
    [PROXY_MEMBER_HEADER]: "false",
    [PROXY_SIG_HEADER]: signProxyIdentity(ID, bind, now),
    ...over,
  });
}

describe("proxyIdentity — 프록시가 붙인 신원 헤더의 서명", () => {
  beforeEach(() => vi.stubEnv("AUTH_SECRET", "s"));
  afterEach(() => vi.unstubAllEnvs());

  it("서명한 신원을 그대로 읽는다", () => {
    expect(readProxyIdentity(headers(), BIND)).toEqual(ID);
  });

  it("member=true 도 서명에 포함된다", () => {
    const id = { ...ID, member: true };
    const h = new Headers({
      [PROXY_SITE_HEADER]: id.siteId,
      [PROXY_VIEWER_HEADER]: id.email,
      [PROXY_MEMBER_HEADER]: "true",
      [PROXY_SIG_HEADER]: signProxyIdentity(id, BIND),
    });
    expect(readProxyIdentity(h, BIND)).toEqual(id);
  });

  it("서명이 없으면 null (헤더만 손으로 붙인 위조 요청)", () => {
    const h = new Headers({
      [PROXY_SITE_HEADER]: ID.siteId,
      [PROXY_VIEWER_HEADER]: ID.email,
      [PROXY_MEMBER_HEADER]: "false",
    });
    expect(readProxyIdentity(h, BIND)).toBeNull();
  });

  it("사이트·이메일·멤버 여부를 바꿔치기하면 null", () => {
    expect(readProxyIdentity(headers({ [PROXY_SITE_HEADER]: "cs2" }), BIND)).toBeNull();
    expect(readProxyIdentity(headers({ [PROXY_VIEWER_HEADER]: "other@gmail.com" }), BIND)).toBeNull();
    expect(readProxyIdentity(headers({ [PROXY_MEMBER_HEADER]: "true" }), BIND)).toBeNull();
  });

  // ── 요청 결속(I3) — 새어 나간 서명으로 다른 제출을 심을 수 없어야 한다 ──
  it("본문이 다르면 null — 서명을 훔쳐도 다른 내용을 심을 수 없다", () => {
    const h = headers();
    expect(readProxyIdentity(h, { ...BIND, body: Buffer.from('{"items":[{"service":"x"}]}') })).toBeNull();
    expect(readProxyIdentity(h, { ...BIND, body: null })).toBeNull();
  });

  it("경로가 다르면 null — 한 경로의 서명을 다른 API 로 돌려쓸 수 없다", () => {
    expect(readProxyIdentity(headers(), { ...BIND, path: "/api/sites/cs1/intake" })).toBeNull();
  });

  it("메서드가 다르면 null", () => {
    expect(readProxyIdentity(headers(), { ...BIND, method: "DELETE" })).toBeNull();
  });

  it("본문 없는 요청도 결속된다(GET)", () => {
    const g: ProxyBinding = { method: "GET", path: "/api/x", body: null };
    expect(readProxyIdentity(headers({}, g), g)).toEqual(ID);
    expect(readProxyIdentity(headers({}, g), { ...g, path: "/api/y" })).toBeNull();
  });

  it("서명을 변조하면 null", () => {
    const sig = signProxyIdentity(ID, BIND);
    const [exp, mac] = sig.split(".");
    expect(readProxyIdentity(headers({ [PROXY_SIG_HEADER]: `${exp}.${mac.slice(0, -1)}x` }), BIND)).toBeNull();
    expect(readProxyIdentity(headers({ [PROXY_SIG_HEADER]: `${Number(exp) + 1000}.${mac}` }), BIND)).toBeNull();
    expect(readProxyIdentity(headers({ [PROXY_SIG_HEADER]: "nodot" }), BIND)).toBeNull();
  });

  it("만료되면 null", () => {
    expect(readProxyIdentity(headers(), BIND, Date.now() + PROXY_SIG_TTL_MS + 1000)).toBeNull();
  });

  it("수명은 1분 — 같은 프로세스 안 한 번 왕복에 필요한 만큼만", () => {
    expect(PROXY_SIG_TTL_MS).toBeLessThanOrEqual(60 * 1000);
  });

  it("다른 AUTH_SECRET 으로 만든 서명은 null", () => {
    const h = headers();
    vi.stubEnv("AUTH_SECRET", "other");
    expect(readProxyIdentity(h, BIND)).toBeNull();
  });

  it("member 헤더가 true/false 가 아니면 null", () => {
    expect(readProxyIdentity(headers({ [PROXY_MEMBER_HEADER]: "yes" }), BIND)).toBeNull();
  });

  it("AUTH_SECRET 이 없으면 서명할 수 없다", () => {
    vi.stubEnv("AUTH_SECRET", "");
    expect(() => signProxyIdentity(ID, BIND)).toThrow();
  });
});

describe("hasProxyIdentityHeaders — /pub 프록시를 타고 왔는가(존재 확인)", () => {
  it("헤더가 하나라도 있으면 true", () => {
    expect(hasProxyIdentityHeaders(new Headers({ [PROXY_SITE_HEADER]: "cs1" }))).toBe(true);
    expect(hasProxyIdentityHeaders(new Headers({ [PROXY_SIG_HEADER]: "x.y" }))).toBe(true);
  });
  it("없으면 false", () => {
    expect(hasProxyIdentityHeaders(new Headers({ "content-type": "application/json" }))).toBe(false);
  });
});
