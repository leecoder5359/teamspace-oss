import { randomBytes } from "node:crypto";

/* 공개 링크. PUBLIC_BASE_URL 이 있으면 그걸로(Funnel 뒤에서는 요청 origin 이 localhost 일 수 있다),
   없으면 프록시 헤더 → 요청 URL 순서. 새 호스트를 하드코딩하지 않는다. */
export function siteUrl(req: Request, slug: string): string {
  const env = process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "");
  if (env) return `${env}/s/${slug}`;
  const h = req.headers;
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  const origin = host ? `${proto}://${host}` : new URL(req.url).origin;
  return `${origin}/s/${slug}`;
}

/** 추측 불가 slug — 9바이트 → base64url 12자. */
export function newSlug(): string {
  return randomBytes(9).toString("base64url");
}
