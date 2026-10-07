import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/* =====================================================================
   /pub API 프록시가 upstream 에 넘기는 "누가 보고 있는가" 헤더의 **서명**.

   프록시는 이미 x-teamspace-site-id·viewer·member 를 붙인다(lib/sites/apiProxy).
   upstream 이 루프백의 다른 서비스면 그걸로 충분하다 — 그 포트에 닿을 수 있다는
   것 자체가 이미 신뢰 경계 안이라는 뜻이니까.

   그런데 upstream 이 **TeamSpace 자신**이면 사정이 다르다. 그 경로(/api/site-intake)는
   세션 쿠키 없이 들어와야 하므로 미들웨어 화이트리스트에 올라가고, 그러면 앱에 닿는
   누구나 저 헤더를 손으로 붙여 흉내 낼 수 있다. 그래서 프록시가 AUTH_SECRET 파생 키로
   짧게 사는 MAC 을 함께 붙이고, 받는 쪽은 MAC 을 먼저 확인한 뒤 **DB 에서 초대를 다시
   판정**한다(둘 다 통과해야 한다 — MAC 은 "프록시가 만든 요청인가", 재판정은 "지금도
   볼 수 있는 사람인가").

   **서명은 요청 하나에 묶인다**: 신원(siteId·email·member)뿐 아니라 메서드·upstream 경로·
   본문 해시까지 MAC 입력에 넣는다. 프록시는 upstream 이 무엇이든 이 헤더를 붙이므로,
   어딘가의 루프백 서비스가 요청 헤더를 로그에 남기면 그 값이 새어 나갈 수 있다 —
   신원만 묶여 있으면 그 값 하나로 **다른 본문**의 제출을 그 게스트 이름으로 심을 수 있다
   (피싱 로그인 URL·공격자 소유 계정을 "받은 계정 정보" 에 넣는 무결성 공격). 본문까지
   묶으면 새어 나간 서명으로는 **그 요청을 재생하는 것 말고는** 아무것도 못 한다.
   수명도 같은 호스트 안의 한 번 왕복이라 1분이면 충분하다.
   ===================================================================== */

export const PROXY_SITE_HEADER = "x-teamspace-site-id";
export const PROXY_VIEWER_HEADER = "x-teamspace-viewer";
export const PROXY_MEMBER_HEADER = "x-teamspace-member";
export const PROXY_SIG_HEADER = "x-teamspace-proxy-sig";

/** 서명 수명. 프록시 → upstream 은 같은 프로세스 안의 한 번 왕복이라 짧게 잡는다. */
export const PROXY_SIG_TTL_MS = 60 * 1000;

export type ProxyIdentity = { siteId: string; email: string; member: boolean };

/** 서명을 묶을 요청. path 는 upstream 에 보내는 경로(쿼리 제외, 예: `/api/site-intake`). */
export type ProxyBinding = { method: string; path: string; body: Uint8Array | null };

function key(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is required for proxy identity signatures.");
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret), Buffer.from("teamspace-site-v1"), Buffer.from("proxy-identity"), 32));
}

function bodyHash(body: Uint8Array | null): string {
  return createHash("sha256").update(body ?? new Uint8Array()).digest("base64url");
}

function mac(i: ProxyIdentity, b: ProxyBinding, exp: number): string {
  const input = [
    i.siteId,
    i.email,
    i.member ? "true" : "false",
    String(exp),
    b.method.toUpperCase(),
    b.path,
    bodyHash(b.body),
  ].join("\n");
  return createHmac("sha256", key()).update(input).digest("base64url");
}

/** `<exp>.<mac>` — x-teamspace-proxy-sig 헤더 값. */
export function signProxyIdentity(i: ProxyIdentity, b: ProxyBinding, now = Date.now()): string {
  const exp = now + PROXY_SIG_TTL_MS;
  return `${exp}.${mac(i, b, exp)}`;
}

/**
 * 프록시가 붙인 헤더 4종을 **이 요청에 대해** 검증해 신원을 돌려준다.
 * 헤더가 맞아도 메서드·경로·본문이 서명 당시와 다르면 null. 이유는 노출하지 않는다.
 */
export function readProxyIdentity(headers: Headers, b: ProxyBinding, now = Date.now()): ProxyIdentity | null {
  const siteId = headers.get(PROXY_SITE_HEADER)?.trim() ?? "";
  const email = headers.get(PROXY_VIEWER_HEADER)?.trim().toLowerCase() ?? "";
  const memberRaw = headers.get(PROXY_MEMBER_HEADER)?.trim() ?? "";
  const sig = headers.get(PROXY_SIG_HEADER)?.trim() ?? "";
  if (!siteId || !email || (memberRaw !== "true" && memberRaw !== "false") || !sig) return null;

  const dot = sig.indexOf(".");
  if (dot <= 0) return null;
  const exp = Number(sig.slice(0, dot));
  if (!Number.isInteger(exp) || exp <= now) return null;

  const identity: ProxyIdentity = { siteId, email, member: memberRaw === "true" };
  const expected = Buffer.from(mac(identity, b, exp));
  const given = Buffer.from(sig.slice(dot + 1));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return identity;
}

/** 프록시 헤더가 **하나라도** 붙어 있는가(= /pub 프록시를 타고 온 요청인가). 검증이 아니라 '존재' 확인.
    OR 인 것이 중요하다 — AND 면 헤더 하나를 빼는 것만으로 이 차단을 지나칠 수 있다. */
export function hasProxyIdentityHeaders(headers: Headers): boolean {
  return Boolean(headers.get(PROXY_SIG_HEADER) ?? headers.get(PROXY_SITE_HEADER) ?? headers.get(PROXY_VIEWER_HEADER) ?? headers.get(PROXY_MEMBER_HEADER));
}
