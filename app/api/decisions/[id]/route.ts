import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

const STATUSES = ["proposed", "accepted", "superseded"] as const;
type Status = (typeof STATUSES)[number];

// PATCH /api/decisions/[id] → 결정 수정(상태/내용)
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const found = await prisma.decision.findFirst({ where: { id, workspaceId }, select: { id: true } });
  if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    context?: string;
    decision?: string;
    status?: string;
  };
  await prisma.decision.update({
    where: { id },
    data: {
      ...(body.title !== undefined ? { title: body.title.trim() || "(제목 없음)" } : {}),
      ...(body.context !== undefined ? { context: body.context.trim() || null } : {}),
      ...(body.decision !== undefined ? { decision: body.decision.trim() || null } : {}),
      ...(STATUSES.includes(body.status as Status) ? { status: body.status as Status } : {}),
    },
  });
  return NextResponse.json({ ok: true });
}

// DELETE /api/decisions/[id]
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  await prisma.decision.deleteMany({ where: { id, workspaceId } });
  return NextResponse.json({ ok: true });
}
