import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { HygieneError, revertHygieneRun } from "@/lib/lessonHygiene/service";

export const runtime = "nodejs";

/**
 * POST /api/lessons/hygiene/<runId>/revert (admin) → { ok, restored, recreated }
 *   적용된(applied) 정리를 적용 직전 백업으로 되돌린다 — 지운 레슨은 원래 id 로 다시 만들고, 바꾼 레슨은 그때 값으로.
 *   적용 뒤에 사람이 고친 내용도 백업 값으로 덮인다. 상태는 reverted 가 되고 두 번 되돌릴 수 없다(409).
 */
export async function POST(_req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  try {
    const r = await revertHygieneRun(guard.workspaceId, runId);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    if (e instanceof HygieneError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
