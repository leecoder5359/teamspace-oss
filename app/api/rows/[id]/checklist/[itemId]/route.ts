import { NextResponse } from "next/server";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

async function ownedItem(rowId: string, itemId: string, workspaceId: string) {
  const item = await prisma.rowChecklistItem.findUnique({
    where: { id: itemId },
    select: { id: true, rowId: true, row: { select: { database: { select: { workspaceId: true } } } } },
  });
  if (!item || item.rowId !== rowId || item.row.database.workspaceId !== workspaceId) return null;
  return item;
}

// PATCH /api/rows/[id]/checklist/[itemId] → 체크 토글/텍스트 수정 { done?, text? }
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; itemId: string }> }) {
  const { id, itemId } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  if (!(await ownedItem(id, itemId, workspaceId))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parsedBody = await readBody(req, z.object({ done: z.boolean().optional(), text: z.string().optional() }));
  if (!parsedBody.ok) return parsedBody.res;
  const body = parsedBody.data;
  const data: { done?: boolean; text?: string } = {};
  if (body.done !== undefined) data.done = !!body.done;
  if (body.text !== undefined) {
    const t = body.text.trim();
    if (t) data.text = t;
  }
  if (Object.keys(data).length === 0) return NextResponse.json({ error: "변경할 내용이 없습니다." }, { status: 400 });
  const item = await prisma.rowChecklistItem.update({ where: { id: itemId }, data });
  return NextResponse.json({ item });
}

// DELETE /api/rows/[id]/checklist/[itemId]
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string; itemId: string }> }) {
  const { id, itemId } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  if (!(await ownedItem(id, itemId, workspaceId))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.rowChecklistItem.delete({ where: { id: itemId } });
  return NextResponse.json({ ok: true });
}
