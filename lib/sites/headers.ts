/* /pub 응답 헤더와 셸 iframe 의 sandbox 속성은 **같은 문자열**에서 나온다 — 둘이 어긋나면
   iframe 으로 볼 때와 URL 을 직접 열 때 권한이 달라진다.
   allow-same-origin: 넣으면 opaque origin 이 풀려 앱 쿠키·/api 에 닿는다(XSS). 절대 금지.
   allow-top-navigation*: 넣으면 콘텐츠가 셸을 피싱 페이지로 바꿔치기할 수 있다. 금지. */
export const SITE_SANDBOX =
  "allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads";

export function siteFileHeaders(contentType: string, length: number): Record<string, string> {
  return {
    "content-type": contentType,
    "content-length": String(length),
    "content-security-policy": `sandbox ${SITE_SANDBOX}; frame-ancestors 'self'`,
    // 올린 HTML 이 외부 CDN 을 불러도 토큰 URL 이 Referer 로 새지 않게.
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=300",
  };
}

export const SITE_DENY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};
