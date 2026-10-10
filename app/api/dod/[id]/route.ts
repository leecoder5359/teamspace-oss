import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";

const DodPatchBody = z.object({
  done: z.boolean().optional(),
  text: z.string().optional(),
});

export const runtime = "nodejs";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const found = await prisma.dodItem.findFirst({ where: { id, workspaceId }, select: { id: true } });
  if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parsed = await readBody(req, DodPatchBody);
  if (!parsed.ok) return parsed.res;
  const b = parsed.data;
  if (b.text !== undefined && !b.text.trim()) return NextResponse.json({ error: "항목을 입력해 주세요." }, { status: 400 });
  // done 은 주어졌을 때만 건드린다 — 종전엔 text 만 고쳐도 done 이 false 로 밀렸다.
  await prisma.dodItem.update({
    where: { id },
    data: {
      ...(b.done !== undefined ? { done: !!b.done } : {}),
      ...(b.text !== undefined ? { text: b.text.trim() } : {}),
    },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  await prisma.dodItem.deleteMany({ where: { id, workspaceId } });
  return NextResponse.json({ ok: true });
}
