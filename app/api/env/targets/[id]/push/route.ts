import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { envError, envGuard, metaOf } from "@/lib/envVault/http";
import { requestPush } from "@/lib/envVault/push";

export const runtime = "nodejs";

// POST /api/env/targets/[id]/push {keys?: string[], channel?} → 바로 값을 주지 않는다.
// push 작업(EnvOp kind push, 30분) + 고위험 승인을 만들고 {opId, approvalId, keys} 를 돌려준다.
// 사람이 승인한 뒤에만 /api/env/push/[opId]/claim 으로 값을 한 번 받을 수 있다.
// 권한: 사람 세션은 admin, 에이전트는 editor 이상(진짜 관문은 승인 클릭 — 에이전트는 고위험 승인을 결정할 수 없다).
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const g = envGuard(await requireCtx("editor"), "target");
  if ("err" in g) return g.err;
  const b = (await request.json().catch(() => ({}))) as { keys?: unknown; channel?: unknown };
  try {
    return NextResponse.json(await requestPush(g.ctx, id, { keys: b.keys, channel: b.channel }, metaOf(request)));
  } catch (e) {
    return envError(e, "push request");
  }
}
