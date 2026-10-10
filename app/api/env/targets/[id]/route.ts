import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { envError, envGuard, metaOf } from "@/lib/envVault/http";
import { deleteTarget, updateTarget } from "@/lib/envVault/push";

export const runtime = "nodejs";

// PATCH /api/env/targets/[id] {config?, account?} → 대상 설정 교체(kind·env 는 고정, 가리키는 곳이 바뀌면 마지막 반영 기록 초기화)
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const g = envGuard(await requireCtx("editor"), "target");
  if ("err" in g) return g.err;
  const b = (await request.json().catch(() => ({}))) as { config?: unknown; account?: unknown };
  try {
    return NextResponse.json({ target: await updateTarget(g.ctx, id, { config: b.config, account: b.account }, metaOf(request)) });
  } catch (e) {
    return envError(e, "target update");
  }
}

// DELETE /api/env/targets/[id] → 대상 삭제(원격에 반영된 값은 건드리지 않는다)
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const g = envGuard(await requireCtx("editor"), "target");
  if ("err" in g) return g.err;
  try {
    await deleteTarget(g.ctx, id, metaOf(request));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return envError(e, "target delete");
  }
}
