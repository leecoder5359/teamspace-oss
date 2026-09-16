import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/* =====================================================================
   퍼블리시 사이트 토큰 — /pub/<token>/<path> 의 유일한 인증 수단.

   샌드박스 iframe(allow-same-origin 없음)은 opaque origin 이라 세션 쿠키가
   실리지 않는다. 그래서 셸(/s/<slug>)이 세션으로 판정한 결과를 짧게 사는
   서명 토큰으로 넘긴다. 경로에 넣는 이유: zip 안의 상대경로 에셋이
   같은 접두사(/pub/<token>/)를 자동으로 물려받는다.

   토큰만 믿지 않는다 — /pub 는 매 요청 DB 에서 초대를 다시 확인한다(회수 즉시 반영).
   키는 AUTH_SECRET 에서 HKDF 로 파생한다(lib/crypto.ts 와 같은 방식, 다른 info).
   ===================================================================== */

export type SiteTokenPayload = { siteId: string; version: number; email: string; exp: number };

export const SITE_TOKEN_TTL_MS = 60 * 60 * 1000;

function key(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is required for site tokens.");
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret), Buffer.from("teamspace-site-v1"), Buffer.from("site-token"), 32));
}

function mac(body: string): string {
  return createHmac("sha256", key()).update(body).digest("base64url");
}

export function signSiteToken(p: { siteId: string; version: number; email: string }, now = Date.now()): string {
  const body = Buffer.from(
    JSON.stringify({ s: p.siteId, v: p.version, e: p.email, x: now + SITE_TOKEN_TTL_MS }),
  ).toString("base64url");
  return `${body}.${mac(body)}`;
}

export function verifySiteToken(token: string, now = Date.now()): SiteTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, sig] = parts;
  const expected = Buffer.from(mac(body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let raw: { s?: unknown; v?: unknown; e?: unknown; x?: unknown };
  try {
    raw = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof raw.s !== "string" || typeof raw.e !== "string") return null;
  if (typeof raw.v !== "number" || !Number.isInteger(raw.v) || raw.v < 1) return null;
  if (typeof raw.x !== "number" || raw.x <= now) return null;
  return { siteId: raw.s, version: raw.v, email: raw.e, exp: raw.x };
}
