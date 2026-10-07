import { SITE_SANDBOX } from "./headers";

/* =====================================================================
   퍼블리시 사이트 API 프록시 — 순수 규칙(검증·경로·헤더). I/O 는 ./upstreamCall.

   페이지의 상대경로 fetch('api/x') 는 /pub/<token>/api/x 가 되고, 라우트가 토큰·초대를
   재판정한 뒤 사이트에 등록된 upstream 으로 넘긴다. upstream 은 **루프백만** 허용한다 —
   임의 호스트를 허용하면 초대 게스트가 서버 안쪽 네트워크(메타데이터·사내 주소)를 두드리는
   SSRF 통로가 된다. 루프백이라도 그 포트에서 도는 서비스는 게스트에게 열린다는 점은 같으니,
   설정 권한(editor)을 가진 사람이 무엇을 연결하는지가 곧 보안 경계다.
   ===================================================================== */

export const SITE_API_MAX_BODY_BYTES = 1024 * 1024;
export const SITE_API_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const SITE_API_DEFAULT_TIMEOUT_MS = 600_000;
export const SITE_API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

// scheme://host:port 만. 경로·쿼리·해시·userinfo 는 정규식이 통째로 거부한다(끝 슬래시 하나만 허용).
// URL 파서를 쓰지 않는 이유: `127.1`·`0x7f.1`·기본 포트 생략 같은 정규화가 검증을 우회하는 표기를 만든다.
const UPSTREAM_RE = /^(https?):\/\/(127\.0\.0\.1|localhost|\[::1\]):([1-9]\d{0,4})\/?$/i;

/** 루프백 upstream 을 정규화한다(소문자·끝 슬래시 제거). 허용하지 않는 값이면 null. */
export function normalizeApiUpstream(raw: string): string | null {
  const m = UPSTREAM_RE.exec(raw.trim());
  if (!m) return null;
  const port = Number(m[3]);
  if (port < 1 || port > 65535) return null;
  return `${m[1].toLowerCase()}://${m[2].toLowerCase()}:${port}`;
}

/** PATCH 입력: null·"" = 해제. */
export function parseApiUpstreamInput(v: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (v === null || v === "") return { ok: true, value: null };
  if (typeof v === "string") {
    if (!v.trim()) return { ok: true, value: null };
    const n = normalizeApiUpstream(v);
    if (n) return { ok: true, value: n };
  }
  return {
    ok: false,
    error: "apiUpstream 은 루프백 주소만 됩니다: http://127.0.0.1:<port> · http://localhost:<port> · http://[::1]:<port> (경로·쿼리 없이), 해제는 null",
  };
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/** 경로 첫 세그먼트가 `api` 인가(프록시 후보). 디코드 실패는 후보 아님. */
export function isApiPath(raw: string[] | undefined): boolean {
  return Boolean(raw && raw.length > 0 && safeDecode(raw[0]) === "api");
}

/** 세그먼트 디코드·검증. `..`·`.`·빈 세그먼트·백슬래시·인코딩된 슬래시·제어문자는 거부(null). */
export function apiPathSegments(raw: string[]): string[] | null {
  const out: string[] = [];
  for (const r of raw) {
    const s = safeDecode(r);
    if (s === null || s === "" || s === "." || s === ".." || /[\\/]/.test(s) || hasControlChar(s)) return null;
    out.push(s);
  }
  return out.length > 0 && out[0] === "api" ? out : null;
}

/** upstream 에 보낼 경로(쿼리 제외). 각 세그먼트를 다시 인코딩한다 — 디코드된 `?`·`#` 가 쿼리로 새지 않게.
    프록시 서명(lib/sites/proxyIdentity)이 묶는 경로도 이 값이다 — 양쪽이 같은 문자열을 봐야 한다. */
export function upstreamPath(segments: string[]): string {
  return `/${segments.map(encodeURIComponent).join("/")}`;
}

/** upstream + 경로 + 원 쿼리스트링. */
export function buildUpstreamUrl(upstream: string, segments: string[], search: string): string {
  return `${upstream}${upstreamPath(segments)}${search}`;
}

/** upstream 으로 넘길 헤더 — 원 요청에서는 content-type·accept 만. 쿠키·authorization·host 는 절대 넘기지 않는다. */
export function upstreamRequestHeaders(
  incoming: Headers,
  who: { siteId: string; email: string; member: boolean },
): Record<string, string> {
  const h: Record<string, string> = {};
  for (const name of ["content-type", "accept"]) {
    const v = incoming.get(name);
    if (v) h[name] = v;
  }
  h["x-teamspace-site-id"] = who.siteId;
  h["x-teamspace-viewer"] = who.email;
  h["x-teamspace-member"] = who.member ? "true" : "false";
  return h;
}

export function siteApiTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.SITE_API_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : SITE_API_DEFAULT_TIMEOUT_MS;
}

/* 샌드박스 iframe 은 opaque origin(Origin: null)이라, 같은 호스트의 /pub 로 fetch 해도 브라우저는
   교차 출처로 취급한다 — CORS 헤더가 없으면 페이지가 응답을 못 읽고, JSON POST 는 프리플라이트에서 막힌다.
   `*` 로 여는 이유: 인증은 쿠키가 아니라 경로의 토큰이라 credentials 가 없고, 합법 호출자의 Origin 은
   늘 null 이라 특정 출처로 좁힐 수 없다(null 로 좁혀도 아무 사이트나 sandbox iframe 으로 흉내 낸다). */
export const SITE_API_CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
};

export const SITE_API_PREFLIGHT_HEADERS: Record<string, string> = {
  ...SITE_API_CORS_HEADERS,
  "access-control-allow-methods": SITE_API_METHODS.join(", "),
  "access-control-allow-headers": "content-type, accept",
  "access-control-max-age": "600",
  "cache-control": "no-store",
};

/** 프록시 응답 헤더. upstream 헤더는 content-type 만 살린다(set-cookie 등은 버림).
    CSP sandbox 도 붙인다 — upstream 이 HTML 을 돌려주고 누군가 그 URL 을 직접 열어도 앱 출처에서 스크립트가 돌지 않게. */
export function proxyResponseHeaders(contentType: string | null): Record<string, string> {
  const h: Record<string, string> = {
    ...SITE_API_CORS_HEADERS,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": `sandbox ${SITE_SANDBOX}; frame-ancestors 'self'`,
  };
  if (contentType) h["content-type"] = contentType;
  return h;
}
