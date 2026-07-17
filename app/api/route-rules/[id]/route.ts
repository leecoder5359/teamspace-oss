import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

// DELETE /api/route-rules/[id] (admin)
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  const rule = await prisma.workspaceRouteRule.findUnique({ where: { id } });
  if (!rule || rule.workspaceId !== guard.workspaceId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  await prisma.workspaceRouteRule.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
