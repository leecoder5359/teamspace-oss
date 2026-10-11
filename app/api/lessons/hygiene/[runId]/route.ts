import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { getHygieneRun, HygieneError } from "@/lib/lessonHygiene/service";

export const runtime = "nodejs";

/**
 * GET /api/lessons/hygiene/<runId> → { run:{…, proposal, signals, hasBackup}, titles:{id:title}, liveIds }
 *   한 실행의 전체 제안(편집자 이상). titles 는 지금 있는 레슨 + 지워진 레슨(백업)의 제목.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  try {
    return NextResponse.json(await getHygieneRun(guard.workspaceId, runId));
  } catch (e) {
    if (e instanceof HygieneError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
