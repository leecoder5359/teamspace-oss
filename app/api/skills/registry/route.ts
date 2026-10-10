import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { filterGroups, getRegistry } from "@/lib/skills/registry";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/skills/registry[?refresh=1][&stale=1][&name=] → SKILL.md 사본 현황(관리자 전용 — 로컬 경로가 드러남).
 *   SKILL_SCAN_ROOTS 가 비면 { configured:false }.
 *   결과는 5분 캐시(머신 단위), refresh=1 이면 다시 스캔. stale·name 은 묶음 필터일 뿐 요약 수치는 전체 기준.
 */
export async function GET(request: Request) {
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  const sp = new URL(request.url).searchParams;
  const reg = await getRegistry({ refresh: sp.get("refresh") === "1" });
  if (!reg.configured) return NextResponse.json(reg, { headers: NO_STORE });
  const groups = filterGroups(reg.groups, { stale: sp.get("stale") === "1", name: sp.get("name") });
  return NextResponse.json({ ...reg, groups, filtered: groups.length !== reg.groups.length }, { headers: NO_STORE });
}
