import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

// DELETE /api/schedules/[id] → 알림 취소
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const schedule = await prisma.schedule.findUnique({ where: { id }, select: { workspaceId: true } });
  if (!schedule || schedule.workspaceId !== guard.workspaceId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  await prisma.schedule.delete({ where: { id } }).catch(() => {});
  return NextResponse.json({ ok: true });
}
