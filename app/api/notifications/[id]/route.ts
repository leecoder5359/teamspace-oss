import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

// PATCH /api/notifications/[id] { read: true|false } → 읽음/안읽음 토글 (본인 것만)
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const n = await prisma.notification.findUnique({ where: { id } });
  if (!n || n.workspaceId !== guard.workspaceId || n.userId !== guard.userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as { read?: boolean };
  const updated = await prisma.notification.update({
    where: { id },
    data: { readAt: body.read === false ? null : new Date() },
  });
  return NextResponse.json({ notification: updated });
}
