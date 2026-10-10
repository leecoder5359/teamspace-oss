import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { envError, envGuard, metaOf } from "@/lib/envVault/http";
import { deleteVar, updateVarMeta } from "@/lib/envVault/service";

export const runtime = "nodejs";

// PATCH /api/env/vars/[id] {note?, syncGroup?} → 값은 그대로 두고 메모·syncGroup 만 교체(빈 문자열·null 은 지움, 관리자 로그인 세션만)
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const g = envGuard(await requireCtx("admin"), "human-admin");
  if ("err" in g) return g.err;
  const b = (await request.json().catch(() => ({}))) as { note?: unknown; syncGroup?: unknown };
  try {
    return NextResponse.json(await updateVarMeta(g.ctx, id, { note: b.note, syncGroup: b.syncGroup }, metaOf(request)));
  } catch (e) {
    return envError(e, "meta");
  }
}

// DELETE /api/env/vars/[id] → 키 삭제(관리자 로그인 세션만, 이력도 함께 삭제)
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const g = envGuard(await requireCtx("admin"), "human-admin");
  if ("err" in g) return g.err;
  try {
    await deleteVar(g.ctx, id, metaOf(request));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return envError(e, "delete");
  }
}
