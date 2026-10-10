import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { envError, envGuard, metaOf, NO_STORE } from "@/lib/envVault/http";
import { claimPush } from "@/lib/envVault/push";

export const runtime = "nodejs";

// POST /api/env/push/[opId]/claim → 사람이 승인(approved)했고 30분 안·처음일 때만, 요청한 그 토큰에게
// {targetId, vars:[{key,value}]} 를 한 번 준다(다시 부르면 409). 응답은 캐시 금지.
export async function POST(request: Request, ctx: { params: Promise<{ opId: string }> }) {
  const { opId } = await ctx.params;
  const g = envGuard(await requireCtx("editor"), "pull");
  if ("err" in g) return g.err;
  try {
    return NextResponse.json(await claimPush(g.ctx, opId, metaOf(request)), { headers: NO_STORE });
  } catch (e) {
    return envError(e, "push claim");
  }
}
