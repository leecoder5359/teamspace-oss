import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { envError, envGuard, metaOf } from "@/lib/envVault/http";
import { reportPush } from "@/lib/envVault/push";

export const runtime = "nodejs";

// POST /api/env/push/[opId]/result {pushed:[key], failed:[{key,error}]} → 반영 결과(키 이름만 쓴다, error 문구는 저장 안 함).
// 지문은 서버가 claim 때 봉인해 둔 값으로 계산한다 — 클라이언트가 보낸 해시·값은 받지 않는다. 한 번만.
export async function POST(request: Request, ctx: { params: Promise<{ opId: string }> }) {
  const { opId } = await ctx.params;
  const g = envGuard(await requireCtx("editor"), "pull");
  if ("err" in g) return g.err;
  const b = (await request.json().catch(() => ({}))) as { pushed?: unknown; failed?: unknown };
  try {
    return NextResponse.json(await reportPush(g.ctx, opId, { pushed: b.pushed, failed: b.failed }, metaOf(request)));
  } catch (e) {
    return envError(e, "push result");
  }
}
