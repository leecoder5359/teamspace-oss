/* 레이트 리밋 정책표 — 경로·메서드 → 정책(순수). 엣지 미들웨어에서 import 된다: Node 전용 import 금지.
 *
 * key:
 *   "ip"     — 항상 IP 로 센다(세션 무시). 로그인 시도·무인증 폼처럼 "누가" 가 아직 없는 경로.
 *   "client" — 세션 사용자 → x-ws-token 해시 → IP 순(lib/rateLimit.ts clientKey).
 *   "viewer" — /pub 프록시 서명 헤더가 있으면 `site:<사이트 id>:<뷰어>`, 없으면 IP(lib/rateLimit.ts siteViewerKey).
 *              프록시는 루프백에서 부르므로 IP 로 세면 모든 사이트·게스트가 한 버킷을 나눠 쓴다.
 *   "pair"   — `pair:<ip>:<페어링 코드>`(lib/rateLimit.ts pairKey). 설치기가 2초마다 폴링하므로 코드별로 센다.
 *              코드 추측은 `also`(IP 전체 합산)가 막는다.
 *
 * 경로 매칭은 세그먼트 경계를 지킨다(`/api/ask` 는 `/api/ask`·`/api/ask/…` 만, `/api/asker` 는 아님).
 * /pub/*·정적 자산·그 밖의 API 는 정책 없음(null). */

export type RateLimitPolicy = {
  name: string;
  limit: number;
  windowMs: number;
  key: "ip" | "client" | "viewer" | "pair";
  /** 같은 요청에 더해 세는 보조 정책(예: pair 의 IP 전체 합산 상한). */
  also?: RateLimitPolicy;
};

const MIN = 60_000;

function under(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(base + "/");
}

export function policyFor(pathname: string, method: string): RateLimitPolicy | null {
  const m = method.toUpperCase();
  // 로그인: signin·callback 만. /api/auth/session·csrf 는 UI 가 수시로 부르므로 제외.
  if (under(pathname, "/api/auth/signin") || under(pathname, "/api/auth/callback")) {
    return { name: "auth", limit: 20, windowMs: MIN, key: "ip" };
  }
  if (under(pathname, "/api/ask")) return { name: "ask", limit: 10, windowMs: MIN, key: "client" };
  if (under(pathname, "/api/search")) return { name: "search", limit: 60, windowMs: MIN, key: "client" };
  if (pathname === "/api/site-intake" && m === "POST") {
    return { name: "site-intake", limit: 10, windowMs: MIN, key: "viewer" };
  }
  if (pathname.startsWith("/api/pair/") && m === "GET") {
    // 설치기 폴링 2초 = 30/분 → 정상 사용도 한도에 닿던 문제. 코드별 60/분 + IP 합산 240/분(코드 추측 방지).
    return {
      name: "pair",
      limit: 60,
      windowMs: MIN,
      key: "pair",
      also: { name: "pair-ip", limit: 240, windowMs: MIN, key: "ip" },
    };
  }
  // CSP 위반 보고(무인증, 브라우저가 보냄) — IP 당 1/분. 초과분은 429 로 버려도 무해하다.
  if (pathname === "/api/csp-report" && m === "POST") return { name: "csp", limit: 1, windowMs: MIN, key: "ip" };
  return null;
}
