import { describe, expect, it } from "vitest";
import { PAIRING_CODE_RE } from "./pairing";
import { PAIR_CODE_RE, clientKey, clientIp, createRateLimiter, keyFor, keyClassOf, OVERFLOW_KEYS, pairKey, SITE_ID_HEADER, SITE_SIG_HEADER, SITE_VIEWER_HEADER, siteViewerKey } from "./rateLimit";
import { PROXY_SIG_HEADER, PROXY_SITE_HEADER, PROXY_VIEWER_HEADER } from "./sites/proxyIdentity";

describe("createRateLimiter", () => {
  it("한도까지 통과하고 그다음은 거절, retryAfterSec 를 준다", () => {
    const rl = createRateLimiter({ limit: 3, windowMs: 60_000 });
    const t = 1_000_000;
    expect(rl.check("k", t)).toMatchObject({ ok: true, remaining: 2 });
    expect(rl.check("k", t)).toMatchObject({ ok: true, remaining: 1 });
    expect(rl.check("k", t)).toMatchObject({ ok: true, remaining: 0 });
    const denied = rl.check("k", t);
    expect(denied.ok).toBe(false);
    expect(denied.remaining).toBe(0);
    // 3/60s → 토큰 1개 회복에 20초
    expect(denied.retryAfterSec).toBe(20);
  });

  it("키끼리 독립", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(rl.check("a", 0).ok).toBe(true);
    expect(rl.check("a", 0).ok).toBe(false);
    expect(rl.check("b", 0).ok).toBe(true);
  });

  it("윈도가 지나면 전량 회복(상한은 limit)", () => {
    const rl = createRateLimiter({ limit: 2, windowMs: 10_000 });
    rl.check("k", 0);
    rl.check("k", 0);
    expect(rl.check("k", 0).ok).toBe(false);
    expect(rl.check("k", 10_000)).toMatchObject({ ok: true, remaining: 1 });
    // 아주 오래 지나도 limit 이상 쌓이지 않는다
    expect(rl.check("x", 0).ok).toBe(true);
    const later = rl.check("x", 10_000_000);
    expect(later).toMatchObject({ ok: true, remaining: 1 });
  });

  it("부분 회복 — 토큰 하나분 시간이 지나면 1건 통과", () => {
    const rl = createRateLimiter({ limit: 6, windowMs: 60_000 }); // 10초에 1개
    for (let i = 0; i < 6; i++) rl.check("k", 0);
    const d = rl.check("k", 5_000);
    expect(d.ok).toBe(false);
    expect(d.retryAfterSec).toBe(5);
    expect(rl.check("k", 10_000).ok).toBe(true);
    expect(rl.check("k", 10_000).ok).toBe(false);
  });

  it("거절은 토큰을 깎지 않는다(두드리기가 대기 시간을 늘리지 않음)", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1_000 });
    rl.check("k", 0);
    for (let i = 0; i < 50; i++) rl.check("k", 100);
    expect(rl.check("k", 1_000).ok).toBe(true);
  });

  it("retryAfterSec 는 최소 1", () => {
    const rl = createRateLimiter({ limit: 1000, windowMs: 1_000 });
    for (let i = 0; i < 1000; i++) rl.check("k", 0);
    expect(rl.check("k", 0).retryAfterSec).toBe(1);
  });

  it("키 수 상한을 넘으면 가장 오래 안 쓴 키부터 제거", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000, max: 2 });
    expect(rl.check("a", 0).ok).toBe(true);
    expect(rl.check("b", 0).ok).toBe(true);
    expect(rl.size()).toBe(2);
    expect(rl.check("c", 0).ok).toBe(true); // a 제거
    expect(rl.size()).toBe(2);
    expect(rl.check("a", 0).ok).toBe(true); // 새 버킷 — b 제거
    expect(rl.check("c", 0).ok).toBe(false); // c 는 남아 있다
  });

  it("최근에 쓴 키는 제거 순서에서 뒤로 간다", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000, max: 2 });
    rl.check("a", 0);
    rl.check("b", 0);
    rl.check("a", 1); // a 갱신 → b 가 가장 오래됨
    rl.check("c", 2); // b 제거
    expect(rl.check("a", 3).ok).toBe(false); // a 는 여전히 소진 상태
    expect(rl.check("b", 3).ok).toBe(true); // b 는 새 버킷
  });
});

const TOK_A = "wst_" + "a".repeat(64);
const TOK_B = "wst_" + "b".repeat(64);

function req(h: Record<string, string>, auth?: { user?: { id?: string; email?: string } } | null) {
  return { headers: new Headers(h), auth };
}

describe("clientKey", () => {
  it("세션 사용자 id 우선, 없으면 email", () => {
    expect(clientKey(req({ "x-ws-token": TOK_A, "x-forwarded-for": "1.2.3.4" }, { user: { id: "u1", email: "a@b.c" } }))).toBe("u:u1");
    expect(clientKey(req({}, { user: { email: "a@b.c" } }))).toBe("u:a@b.c");
  });

  it("세션이 없으면 x-ws-token 해시(앞 12자) — 원문은 키에 남지 않는다", () => {
    const k = clientKey(req({ "x-ws-token": TOK_A, "x-forwarded-for": "1.2.3.4" }, null));
    expect(k).toMatch(/^t:[0-9a-f]{12}$/);
    expect(k).not.toContain(TOK_A.slice(4, 20));
    expect(clientKey(req({ "x-ws-token": TOK_A }))).toBe(k); // 결정적
    expect(clientKey(req({ "x-ws-token": TOK_B }))).not.toBe(k);
  });

  it("형식이 틀린 토큰은 키로 쓰지 않고 IP 로 센다(위조 토큰 회전 방지)", () => {
    const k1 = clientKey(req({ "x-ws-token": "wst_fake1", "x-real-ip": "5.6.7.8" }));
    const k2 = clientKey(req({ "x-ws-token": "wst_fake2", "x-real-ip": "5.6.7.8" }));
    expect(k1).toBe("ip:5.6.7.8");
    expect(k2).toBe(k1);
  });

  it("그다음 x-forwarded-for 가장 오른쪽 값, x-real-ip, fallbackIp, unknown 순", () => {
    expect(clientKey(req({ "x-forwarded-for": " 1.2.3.4 , 10.0.0.1" }))).toBe("ip:10.0.0.1");
    expect(clientKey(req({ "x-forwarded-for": "1.2.3.4" }))).toBe("ip:1.2.3.4");
    expect(clientKey(req({ "x-real-ip": "5.6.7.8" }))).toBe("ip:5.6.7.8");
    expect(clientKey(req({}), "9.9.9.9")).toBe("ip:9.9.9.9");
    expect(clientKey(req({}))).toBe("ip:unknown");
  });

  it("빈 user 객체는 세션으로 치지 않는다", () => {
    expect(clientKey(req({ "x-real-ip": "5.6.7.8" }, { user: {} }))).toBe("ip:5.6.7.8");
  });
});

describe("clientIp", () => {
  it("클라이언트가 붙인 왼쪽 XFF 값은 무시 — 위조해도 가장 가까운 프록시 홉으로 센다", () => {
    const forged = (i: number) => new Headers({ "x-forwarded-for": `203.0.113.${i}, 100.64.0.7` });
    expect(clientIp(forged(1))).toBe("100.64.0.7");
    expect(clientIp(forged(2))).toBe("100.64.0.7");
  });
  it("빈 항목·공백은 건너뛴다", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4, " }))).toBe("1.2.3.4");
    expect(clientIp(new Headers({ "x-forwarded-for": " , ", "x-real-ip": "5.6.7.8" }))).toBe("5.6.7.8");
  });
  it("XFF·x-real-ip 둘 다 없으면 fallback, 그것도 없으면 null", () => {
    expect(clientIp(new Headers(), "9.9.9.9")).toBe("9.9.9.9");
    expect(clientIp(new Headers())).toBeNull();
  });
});

describe("siteViewerKey", () => {
  it("헤더 이름은 lib/sites/proxyIdentity 상수와 같다", () => {
    expect(SITE_SIG_HEADER).toBe(PROXY_SIG_HEADER);
    expect(SITE_ID_HEADER).toBe(PROXY_SITE_HEADER);
    expect(SITE_VIEWER_HEADER).toBe(PROXY_VIEWER_HEADER);
  });
  it("프록시 서명이 있으면 site:<사이트>:<뷰어> — 게스트·사이트마다 다른 버킷", () => {
    const h = (site: string, viewer: string) =>
      new Headers({ [SITE_SIG_HEADER]: "123.abc", [SITE_ID_HEADER]: site, [SITE_VIEWER_HEADER]: viewer, "x-forwarded-for": "127.0.0.1" });
    expect(siteViewerKey(h("s1", "A@x.com"))).toBe("site:s1:a@x.com");
    expect(siteViewerKey(h("s1", "b@x.com"))).toBe("site:s1:b@x.com");
    expect(siteViewerKey(h("s2", "a@x.com"))).toBe("site:s2:a@x.com");
  });
  it("서명 헤더가 없거나 사이트·뷰어가 비면 IP 로 센다", () => {
    expect(siteViewerKey(new Headers({ [SITE_ID_HEADER]: "s1", [SITE_VIEWER_HEADER]: "a@x.com", "x-real-ip": "5.6.7.8" }))).toBe("ip:5.6.7.8");
    expect(siteViewerKey(new Headers({ [SITE_SIG_HEADER]: "1.a", [SITE_ID_HEADER]: "s1" }))).toBe("ip:unknown");
  });
});

describe("클래스별 키 상한 + overflow 버킷", () => {
  it("keyClassOf", () => {
    expect(keyClassOf("t:abc")).toBe("token");
    expect(keyClassOf("ip:1.2.3.4")).toBe("ip");
    expect(keyClassOf("pair:1.2.3.4:X")).toBe("ip");
    expect(keyClassOf("u:1")).toBeNull();
  });

  it("상한이 차면 새 키는 클래스 overflow 버킷을 공유 — 폭주한 쪽만 서로 깎인다", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000, classMax: { token: 2 } });
    expect(rl.check("t:a", 0).ok).toBe(true);
    expect(rl.check("t:b", 0).ok).toBe(true);
    expect(rl.check("t:c", 0).ok).toBe(true); // overflow 첫 사용
    expect(rl.check("t:d", 0).ok).toBe(false); // overflow 공유 → 소진
    expect(rl.check("t:a", 0).ok).toBe(false); // 기존 키는 자기 버킷
    expect(rl.size()).toBe(3);
    expect(rl.check(OVERFLOW_KEYS.token, 0).ok).toBe(false);
  });

  it("다른 클래스는 영향 없음 — 토큰 폭주가 ip 키를 밀어내지 않는다", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000, max: 6, classMax: { token: 2, ip: 3 } });
    rl.check("ip:1", 0);
    for (let i = 0; i < 50; i++) rl.check(`t:${i}`, 0);
    expect(rl.check("ip:1", 0).ok).toBe(false); // 여전히 자기 버킷(소진 상태)
    expect(rl.check("ip:2", 0).ok).toBe(true);
  });

  it("LRU 로 밀려난 키는 클래스 카운트에서 빠져 자리가 다시 생긴다", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000, max: 2, classMax: { ip: 2 } });
    rl.check("ip:a", 0);
    rl.check("ip:b", 0);
    rl.check("ip:c", 0); // overflow 로 감 → LRU 로 ip:a 제거(카운트 1)
    expect(rl.check("ip:d", 0).ok).toBe(true); // 새 자기 버킷(overflow 아님)
  });

  it("창이 지나 다 리필된 버킷은 슬롯을 회수 — 새 키가 overflow 가 아닌 자기 버킷을 받는다", () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 60_000, classMax: { ip: 2 } });
    rl.check("ip:a", 0);
    rl.check("ip:b", 0);
    expect(rl.check("ip:c", 1_000).ok).toBe(true); // 활성 → overflow
    expect(rl.check("ip:d", 1_000).ok).toBe(false); // overflow 공유
    // 창 경과: ip:a·ip:b 는 다 리필됨 → ip:e 는 회수한 슬롯에서 자기 버킷
    expect(rl.check("ip:e", 61_000).ok).toBe(true);
    expect(rl.check("ip:e", 61_000).ok).toBe(false); // 자기 버킷이 소진됨(overflow 와 무관한 증거: ip:f 는 별도)
    expect(rl.check("ip:f", 61_000).ok).toBe(true); // 두 번째 회수
    expect(rl.check("ip:g", 61_000).ok).toBe(true); // 다시 가득(e·f 활성) → overflow, 61s 에 overflow 도 리필
  });

  it("전부 활성이면 새 키는 overflow 로 간다", () => {
    const rl = createRateLimiter({ limit: 2, windowMs: 60_000, classMax: { ip: 2 } });
    rl.check("ip:a", 0);
    rl.check("ip:b", 0);
    const t = 30_000; // 창의 절반 — 둘 다 아직 예산을 쓴 상태
    expect(rl.check("ip:c", t).ok).toBe(true);
    expect(rl.check("ip:c", t).ok).toBe(true);
    expect(rl.check("ip:c", t).ok).toBe(false); // overflow 버킷(limit 2) 소진 — 자기 슬롯이 없음
    expect(rl.check("ip:d", t).ok).toBe(false); // 같은 overflow 공유
    expect(rl.size()).toBe(3);
  });
});

const CODE_A = "a".repeat(32);
const CODE_B = "0123456789abcdef".repeat(2);

describe("keyFor", () => {
  const pol = (key: "ip" | "client" | "viewer" | "pair") => ({ key });
  it("ip 정책은 세션·토큰을 무시한다", () => {
    const r = req({ "x-ws-token": TOK_A, "x-real-ip": "5.6.7.8" }, { user: { id: "u1" } });
    expect(keyFor(pol("ip"), r)).toBe("ip:5.6.7.8");
    expect(keyFor(pol("client"), r)).toBe("u:u1");
  });
  it("client 정책: 정상 토큰은 t:, 형식 불량 토큰은 IP 폴백", () => {
    expect(keyFor(pol("client"), req({ "x-ws-token": TOK_A }))).toMatch(/^t:/);
    expect(keyFor(pol("client"), req({ "x-ws-token": "nope", "x-real-ip": "5.6.7.8" }))).toBe("ip:5.6.7.8");
  });
  it("RATE_LIMIT=off 킬스위치(off) → null", () => {
    expect(keyFor(pol("ip"), req({}), { off: true })).toBeNull();
    expect(keyFor(pol("client"), req({}), { off: true })).toBeNull();
  });
  it("pair 정책은 IP+페어링 코드별 — 같은 IP 의 설치기 둘은 다른 버킷", () => {
    const h = { "x-real-ip": "5.6.7.8" };
    const a = keyFor(pol("pair"), { ...req(h), pathname: `/api/pair/${CODE_A}` });
    const b = keyFor(pol("pair"), { ...req(h), pathname: `/api/pair/${CODE_B}/route-rule` });
    expect(a).toBe(`pair:5.6.7.8:${CODE_A}`);
    expect(b).toBe(`pair:5.6.7.8:${CODE_B}`);
    expect(pairKey("/api/pair", new Headers(h))).toBe("ip:5.6.7.8");
  });
  it("형식 불량 코드는 IP 키 — 코드 회전으로 pair: 슬롯을 못 쓴다", () => {
    const h = new Headers({ "x-real-ip": "5.6.7.8" });
    for (const bad of ["AAA111", "x".repeat(64), CODE_A.toUpperCase(), CODE_A.slice(1), `${CODE_A}0`]) {
      expect(pairKey(`/api/pair/${bad}`, h)).toBe("ip:5.6.7.8");
    }
    const rl = createRateLimiter({ limit: 100, windowMs: 60_000 });
    for (let i = 0; i < 20_000; i++) rl.check(pairKey(`/api/pair/junk${i}`, h), 0);
    expect(rl.size()).toBe(1);
  });
  it("approve 등 비폴링 하위 경로는 코드 키가 아니라 IP 키", () => {
    const h = new Headers({ "x-real-ip": "5.6.7.8" });
    expect(pairKey("/api/pair/approve", h)).toBe("ip:5.6.7.8");
  });
  it("PAIR_CODE_RE 는 lib/pairing.ts 의 PAIRING_CODE_RE 와 같다", () => {
    expect(PAIR_CODE_RE.source).toBe(PAIRING_CODE_RE.source);
    expect(PAIR_CODE_RE.flags).toBe(PAIRING_CODE_RE.flags);
  });
});
