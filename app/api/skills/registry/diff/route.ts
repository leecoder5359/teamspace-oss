import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { diffCopies } from "@/lib/skills/registry";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };
const ID = /^[0-9a-f]{12}$/;

/**
 * GET /api/skills/registry/diff?a=<사본 id>&b=<사본 id> → 두 사본의 줄 단위 unified diff(관리자 전용).
 * 최근 스캔에 있는 id 만 받는다 — 임의 경로는 읽지 않는다. 출력은 400줄에서 자른다.
 */
export async function GET(request: Request) {
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  const sp = new URL(request.url).searchParams;
  const a = sp.get("a") ?? "";
  const b = sp.get("b") ?? "";
  if (!ID.test(a) || !ID.test(b)) return NextResponse.json({ error: "a·b 에 사본 id(12자리)를 주세요." }, { status: 400, headers: NO_STORE });
  const r = await diffCopies(a, b);
  if ("error" in r) {
    if (r.error === "not_configured") return NextResponse.json({ configured: false }, { headers: NO_STORE });
    if (r.error === "unknown_id") return NextResponse.json({ error: "최근 스캔에 없는 사본입니다. 목록을 새로 고친 뒤 다시 시도하세요." }, { status: 404, headers: NO_STORE });
    return NextResponse.json({ error: "파일을 읽지 못했습니다(지워졌거나 옮겨졌을 수 있음)." }, { status: 410, headers: NO_STORE });
  }
  return NextResponse.json({ configured: true, ...r }, { headers: NO_STORE });
}
