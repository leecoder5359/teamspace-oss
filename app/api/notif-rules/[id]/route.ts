import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

async function owned(id: string, workspaceId: string) {
  const r = await prisma.notifRule.findUnique({ where: { id } });
  return r && r.workspaceId === workspaceId ? r : null;
}

// PATCH /api/notif-rules/[id] → 활성 토글 { enabled }
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  if (!(await owned(id, workspaceId))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { enabled?: boolean };
  if (body.enabled === undefined) return NextResponse.json({ error: "변경할 내용이 없습니다." }, { status: 400 });
  const rule = await prisma.notifRule.update({ where: { id }, data: { enabled: !!body.enabled } });
  return NextResponse.json({ rule });
}

// DELETE /api/notif-rules/[id]
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  if (!(await owned(id, workspaceId))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.notifRule.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
