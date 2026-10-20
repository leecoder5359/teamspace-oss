import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);

/** 이 크기(바이트) 이하는 압축 이득보다 비용이 커서 평문으로 둔다(Next 압축 미들웨어의 기본 문턱과 같다). */
const MIN_BYTES = 1024;

/** Accept-Encoding 에 gzip 이 있고 q=0 으로 끄지 않았는가. */
export function acceptsGzip(header: string | null): boolean {
  if (!header) return false;
  return header.split(",").some((part) => {
    const [token, ...params] = part.trim().toLowerCase().split(";").map((s) => s.trim());
    if (token !== "gzip") return false;
    const q = params.find((p) => p.startsWith("q="));
    return !q || Number(q.slice(2)) > 0;
  });
}

/**
 * NextResponse.json 대신 쓰는 큰 JSON 응답. `next start` 의 압축 미들웨어가 라우트 핸들러
 * 응답에는 걸리지 않아(Next 16.2 실측: 미들웨어 401 은 gzip, 라우트 핸들러는 평문) 그래프·보드·
 * 레슨·페이지 목록처럼 수백 KB 짜리 응답만 여기서 직접 gzip 한다.
 * 요청이 없으면(테스트의 GET() 직접 호출) 평문.
 */
export async function gzipJson(req: Request | undefined, data: unknown, init?: ResponseInit): Promise<Response> {
  const body = Buffer.from(JSON.stringify(data), "utf8");
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  // 호출부가 준 Vary 는 살리고 Accept-Encoding 만 덧붙인다
  const vary = headers.get("vary");
  if (!vary) headers.set("vary", "Accept-Encoding");
  else if (!/(^|,)\s*accept-encoding\s*(,|$)/i.test(vary)) headers.set("vary", `${vary}, Accept-Encoding`);
  if (body.length <= MIN_BYTES || !acceptsGzip(req?.headers.get("accept-encoding") ?? null)) {
    return new Response(body, { ...init, headers });
  }
  headers.set("content-encoding", "gzip");
  return new Response(new Uint8Array(await gzipAsync(body)), { ...init, headers });
}
