import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { verifySiteToken } from "@/lib/sites/token";
import { siteAccessById } from "@/lib/sites/server";
import { normalizeEmail } from "@/lib/sites/access";
import { resolveSiteFile, sitesRoot } from "@/lib/sites/store";
import { mimeFor, SITE_MIME } from "@/lib/sites/bundle";
import { injectNavScript, NAV_SCRIPT, NAV_SCRIPT_PATH, RESERVED_SITE_DIR } from "@/lib/sites/shellPath";
import { siteFileHeaders, SITE_DENY_HEADERS } from "@/lib/sites/headers";
import {
  apiPathSegments,
  buildUpstreamUrl,
  isApiPath,
  proxyResponseHeaders,
  siteApiTimeoutMs,
  upstreamPath,
  upstreamRequestHeaders,
  SITE_API_CORS_HEADERS,
  SITE_API_MAX_BODY_BYTES,
  SITE_API_MAX_RESPONSE_BYTES,
  SITE_API_PREFLIGHT_HEADERS,
} from "@/lib/sites/apiProxy";
import { callUpstream, readBodyLimited } from "@/lib/sites/upstreamCall";
import { PROXY_SIG_HEADER, signProxyIdentity } from "@/lib/sites/proxyIdentity";

export const runtime = "nodejs";

/* =====================================================================
   GET /pub/<token>/<...path> — 퍼블리시 사이트 파일을 **샌드박스로만** 서빙한다.

   /api 밖이고 미들웨어도 통과시킨다: 셸의 sandbox iframe 은 opaque origin 이라
   세션 쿠키가 실리지 않는다. 대신
     ① HMAC 토큰(셸이 세션으로 판정한 결과, 1시간) 을 검증하고
     ② 매 요청 DB 에서 초대·사이트 상태를 다시 판정한다(회수 즉시 반영).
   모든 파일 응답에 CSP sandbox(allow-same-origin 없음)를 붙이므로 URL 을 직접
   열어도 앱 쿠키·/api 에 닿지 못한다. (lib/sites/headers 참조)

   ── API 프록시: GET|POST|PUT|PATCH|DELETE /pub/<token>/api/<...> ──
   페이지가 상대경로 fetch('api/x') 를 부르면 여기로 온다. 사이트에 apiUpstream 이 있으면
   같은 ①② 판정을 거친 뒤 그 로컬 서버의 /api/x 로 넘긴다(없으면 GET 은 기존 파일 서빙, 나머지는 404).
   - 페이지 origin 이 opaque 라 앱 쿠키로는 인증할 수 없다 → 경로의 토큰이 유일한 인증이고,
     토큰만 믿지 않고 매 요청 초대를 재판정한다. 같은 이유로 브라우저는 이 호출을 교차 출처로 보므로
     CORS(`*`, credentials 없음)·OPTIONS 프리플라이트를 여기서 답한다.
   - upstream 은 루프백만(lib/sites/apiProxy) — 게스트 요청이 서버 안쪽 네트워크로 새는 SSRF 를 막는다.
   - 원 요청 헤더는 content-type·accept 만 넘기고(쿠키·authorization·host 차단), 판정 결과를
     x-teamspace-site-id·viewer·member 로 붙인다. 응답은 status·body·content-type 만 살린다.
   - 접근 이력(SiteAccess)은 남기지 않는다 — 셸 열람만 기록하는 규칙 유지.
   ===================================================================== */

const NAV_SCRIPT_MIME = SITE_MIME.js;

type Ctx = { params: Promise<{ token: string; path: string[] }> };

const deny = (status: 403 | 404, api = false) =>
  new NextResponse(null, { status, headers: api ? { ...SITE_DENY_HEADERS, ...SITE_API_CORS_HEADERS } : SITE_DENY_HEADERS });

const apiError = (status: number, error: string) =>
  NextResponse.json({ error }, { status, headers: proxyResponseHeaders(null) });

type Judged =
  | { ok: false; res: NextResponse }
  | { ok: true; siteId: string; version: number; email: string; member: boolean; apiUpstream: string | null };

async function judge(token: string, api: boolean): Promise<Judged> {
  const payload = verifySiteToken(token);
  if (!payload) return { ok: false, res: deny(403, api) };
  const access = await siteAccessById(payload.siteId, payload.email);
  if (access.result === "not_found") return { ok: false, res: deny(404, api) };
  if (access.result !== "ok") return { ok: false, res: deny(403, api) };
  return {
    ok: true,
    siteId: payload.siteId,
    version: payload.version,
    email: normalizeEmail(payload.email) ?? payload.email.trim().toLowerCase(),
    member: Boolean(access.member),
    apiUpstream: access.site?.apiUpstream ?? null,
  };
}

async function proxy(req: Request, j: Extract<Judged, { ok: true }>, raw: string[]): Promise<NextResponse> {
  if (!j.apiUpstream) return deny(404, true);
  const segments = apiPathSegments(raw);
  if (!segments) return deny(404, true);

  let body: Buffer | null = null;
  if (req.method !== "GET") {
    const read = await readBodyLimited(req, SITE_API_MAX_BODY_BYTES);
    if (!read.ok) return apiError(413, "요청 본문이 너무 큽니다(1MB 초과)");
    body = read.body;
  }

  const r = await callUpstream(buildUpstreamUrl(j.apiUpstream, segments, new URL(req.url).search), {
    method: req.method,
    headers: {
      ...upstreamRequestHeaders(req.headers, { siteId: j.siteId, email: j.email, member: j.member }),
      // upstream 이 TeamSpace 자신일 때(/api/site-intake) 헤더 위조를 막는 짧은 수명 MAC.
      // **이 요청 하나에 묶는다**(메서드·경로·본문) — 새어 나가도 다른 제출을 심는 데 못 쓴다.
      // 다른 루프백 upstream 은 그냥 무시하면 된다. (lib/sites/proxyIdentity)
      [PROXY_SIG_HEADER]: signProxyIdentity(
        { siteId: j.siteId, email: j.email, member: j.member },
        { method: req.method, path: upstreamPath(segments), body },
      ),
    },
    body,
    timeoutMs: siteApiTimeoutMs(),
    maxResponseBytes: SITE_API_MAX_RESPONSE_BYTES,
    signal: req.signal,
  });
  // 내부 주소·원인은 응답에 싣지 않는다.
  switch (r.kind) {
    case "connect_error":
    case "aborted":
      return apiError(502, "upstream 에 연결할 수 없습니다");
    case "bad_response":
      return apiError(502, "upstream 응답을 읽지 못했습니다");
    case "too_large":
      return apiError(502, "upstream 응답이 너무 큽니다(5MB 초과)");
    case "timeout":
      return apiError(504, "upstream 응답 시간이 초과됐습니다");
  }
  if (r.status < 200 || r.status > 599) return apiError(502, "upstream 응답을 읽지 못했습니다");
  const nullBody = r.status === 204 || r.status === 205 || r.status === 304;
  return new NextResponse(nullBody ? null : new Uint8Array(r.body), {
    status: r.status,
    headers: proxyResponseHeaders(nullBody ? null : r.contentType),
  });
}

export async function GET(req: Request, { params }: Ctx) {
  const { token, path: raw } = await params;
  const api = isApiPath(raw);
  const j = await judge(token, api);
  if (!j.ok) return j.res;

  if (api && j.apiUpstream) return proxy(req, j, raw);

  let segments: string[];
  try {
    segments = (raw ?? []).map((s) => decodeURIComponent(s));
  } catch {
    return deny(404);
  }
  // 예약 폴더 __ts/ — 번들 파일이 아니라 /pub 가 직접 답한다(번들 검증이 이 폴더를 뺀다).
  if (segments[0] === RESERVED_SITE_DIR) {
    if (segments.join("/") !== NAV_SCRIPT_PATH) return deny(404);
    const js = Buffer.from(NAV_SCRIPT, "utf8");
    return new NextResponse(new Uint8Array(js), { headers: siteFileHeaders(NAV_SCRIPT_MIME, js.length) });
  }

  const file = resolveSiteFile(sitesRoot(), j.siteId, j.version, segments);
  const type = file ? mimeFor(file) : null;
  if (!file || !type) return deny(404);

  let data: Buffer;
  try {
    data = await fs.readFile(file);
  } catch {
    return deny(404);
  }
  const download = new URL(req.url).searchParams.has("download") ? segments[segments.length - 1] : undefined;
  // HTML 이면 셸 주소창 동기화용 <script src> 를 붙인다. 같은 토큰 경로의 파일이라 CSP(sandbox) 를
  // 넓히지 않고, 인라인 스크립트도 아니다. 다운로드로 받을 때는 원본 그대로.
  if (!download && type.startsWith("text/html")) {
    // latin1 왕복은 바이트를 그대로 보존한다(원본 인코딩과 무관, 태그는 ASCII).
    data = Buffer.from(injectNavScript(data.toString("latin1"), `/pub/${token}/${NAV_SCRIPT_PATH}`), "latin1");
  }
  return new NextResponse(new Uint8Array(data), { headers: siteFileHeaders(type, data.length, download) });
}

async function apiOnly(req: Request, { params }: Ctx) {
  const { token, path: raw } = await params;
  const j = await judge(token, true);
  if (!j.ok) return j.res;
  if (!isApiPath(raw)) return deny(404, true);
  return proxy(req, j, raw);
}

export const POST = apiOnly;
export const PUT = apiOnly;
export const PATCH = apiOnly;
export const DELETE = apiOnly;

/** CORS 프리플라이트. 판정 없이 답한다(DB·토큰 정보 노출 없음) — 막으면 만료 토큰의 403 을 페이지가 읽지 못하고 네트워크 오류로만 보인다. */
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: SITE_API_PREFLIGHT_HEADERS });
}
