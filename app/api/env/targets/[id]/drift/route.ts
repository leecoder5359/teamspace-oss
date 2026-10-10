import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { envError, envGuard, metaOf } from "@/lib/envVault/http";
import { recordDrift } from "@/lib/envVault/push";

export const runtime = "nodejs";

// POST /api/env/targets/[id]/drift {results: {KEY: match|differs|missing_remote|remote_only|present}}
// → CLI 가 원격과 비교한 드리프트 점검 결과(키 이름·상태만)를 대상에 기록. 값·해시는 받지 않는다.
// 권한: target 과 같다(사람 세션은 admin, 에이전트는 editor 이상).
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const g = envGuard(await requireCtx("editor"), "target");
  if ("err" in g) return g.err;
  const b = (await request.json().catch(() => ({}))) as { results?: unknown };
  try {
    return NextResponse.json(await recordDrift(g.ctx, id, { results: b.results }, metaOf(request)));
  } catch (e) {
    return envError(e, "drift");
  }
}
