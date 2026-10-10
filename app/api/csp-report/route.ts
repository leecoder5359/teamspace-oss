import { NextResponse } from "next/server";
import { log } from "@/lib/log";

export const runtime = "nodejs";

/** 보고 본문 상한 — 정상 CSP 보고는 수백 바이트다. */
export const MAX_REPORT_BYTES = 2048;

// POST /api/csp-report — CSP Report-Only 위반 수집(report-uri / report-to).
//   ⚠️ 무인증 — 브라우저는 보고를 자격 증명 없이 보낸다(authz-coverage 화이트리스트·미들웨어 isOpenApi 에 등록).
//   남용 방어: 본문 2KB 상한(content-length 선검사 + 실제 바이트 검사) · IP 당 1/분(미들웨어 csp 정책, lib/rateLimitPolicy.ts).
//   저장하지 않고 로그(warn csp.violation)만 남긴다. URL 은 쿼리·프래그먼트를 떼어 토큰 유출을 막는다.
//   응답은 항상 204(형식 불량은 조용히 버림), 크기 초과만 413.
export async function POST(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_REPORT_BYTES) return new NextResponse(null, { status: 413 });

  // content-length 가 없거나 거짓일 수 있다 — 상한+1 바이트까지만 읽어 판정한다.
  // 클라이언트 중단·깨진 스트림·형식 불량은 전부 조용히 204 — 500 을 내지 않는다.
  let parsed: unknown;
  try {
    const raw = await readCapped(request, MAX_REPORT_BYTES);
    if (raw === null) return new NextResponse(null, { status: 413 });
    parsed = JSON.parse(raw);
  } catch {
    return new NextResponse(null, { status: 204 });
  }
  const body = pickBody(parsed);
  if (body) {
    log.warn("csp.violation", {
      msg: "CSP 위반 보고",
      directive: str(body["effective-directive"] ?? body["effectiveDirective"] ?? body["violated-directive"] ?? body["violatedDirective"]),
      blocked: stripUrl(body["blocked-uri"] ?? body["blockedURL"] ?? body["blocked-url"]),
      document: stripUrl(body["document-uri"] ?? body["documentURL"]),
      disposition: str(body["disposition"]),
    });
  }
  return new NextResponse(null, { status: 204 });
}

async function readCapped(request: Request, max: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** report-uri 형식 { "csp-report": {…} } 또는 Reporting API 배열 [{ type:"csp-violation", body:{…} }] 에서 본문 하나를 꺼낸다. */
function pickBody(v: unknown): Record<string, unknown> | null {
  if (Array.isArray(v)) {
    const hit = v.find((x) => x && typeof x === "object" && (x as { type?: unknown }).type === "csp-violation") as { body?: unknown } | undefined;
    return hit && hit.body && typeof hit.body === "object" ? (hit.body as Record<string, unknown>) : null;
  }
  if (v && typeof v === "object") {
    const inner = (v as Record<string, unknown>)["csp-report"];
    return inner && typeof inner === "object" ? (inner as Record<string, unknown>) : null;
  }
  return null;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v.slice(0, 200) : null);

function stripUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  return s.split(/[?#]/)[0];
}
