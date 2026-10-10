import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";

const GlossaryPatchBody = z.object({
  term: z.string().optional(),
  definition: z.string().optional(),
});

export const runtime = "nodejs";

// PATCH /api/glossary/[id] → 용어 수정(용어명/정의)
// 넘어온 필드만 고친다 — undefined 는 '건드리지 않음'이고 빈 문자열은 '비움'이다.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const found = await prisma.glossaryTerm.findFirst({ where: { id, workspaceId }, select: { id: true } });
  if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = await readBody(req, GlossaryPatchBody);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  // 용어·정의는 비울 수 없다(POST 가 둘 다 필수라 같은 계약을 유지한다)
  if (body.term !== undefined && !body.term.trim()) return NextResponse.json({ error: "용어를 입력해 주세요." }, { status: 400 });
  if (body.definition !== undefined && !body.definition.trim()) return NextResponse.json({ error: "정의를 입력해 주세요." }, { status: 400 });
  await prisma.glossaryTerm.update({
    where: { id },
    data: {
      ...(body.term !== undefined ? { term: body.term.trim() } : {}),
      ...(body.definition !== undefined ? { definition: body.definition.trim() } : {}),
    },
  });
  return NextResponse.json({ ok: true });
}


// DELETE /api/glossary/[id]
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  await prisma.glossaryTerm.deleteMany({ where: { id, workspaceId } });
  return NextResponse.json({ ok: true });
}
