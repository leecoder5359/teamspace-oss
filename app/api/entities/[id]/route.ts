import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";

const EntityPatchBody = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  fields: z.string().optional(),
});

export const runtime = "nodejs";

// PATCH /api/entities/[id] → 엔티티 수정(이름/설명/필드)
// 넘어온 필드만 고친다 — undefined 는 '건드리지 않음'이고 빈 문자열은 '비움'이다.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const found = await prisma.entity.findFirst({ where: { id, workspaceId }, select: { id: true } });
  if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = await readBody(req, EntityPatchBody);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  if (body.name !== undefined && !body.name.trim()) return NextResponse.json({ error: "엔티티 이름을 입력해 주세요." }, { status: 400 });
  await prisma.entity.update({
    where: { id },
    data: {
      ...(body.name !== undefined ? { name: body.name.trim() } : {}),
      ...(body.description !== undefined ? { description: body.description.trim() || null } : {}),
      ...(body.fields !== undefined ? { fields: body.fields.trim() || null } : {}),
    },
  });
  return NextResponse.json({ ok: true });
}


export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  await prisma.entity.deleteMany({ where: { id, workspaceId } });
  return NextResponse.json({ ok: true });
}
