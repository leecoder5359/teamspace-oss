import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

// PATCH /api/changelog/[id] → 변경 이력 수정(제목/버전/본문)
// 넘어온 필드만 고친다 — undefined 는 '건드리지 않음'이고 빈 문자열은 '비움'이다.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const found = await prisma.changelogEntry.findFirst({ where: { id, workspaceId }, select: { id: true } });
  if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { title?: string; version?: string; body?: string };
  if (body.title !== undefined && !body.title.trim()) return NextResponse.json({ error: "제목을 입력해 주세요." }, { status: 400 });
  await prisma.changelogEntry.update({
    where: { id },
    data: {
      ...(body.title !== undefined ? { title: body.title.trim() } : {}),
      ...(body.version !== undefined ? { version: body.version.trim() || null } : {}),
      ...(body.body !== undefined ? { body: body.body.trim() || null } : {}),
    },
  });
  return NextResponse.json({ ok: true });
}


// DELETE /api/changelog/[id]
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  await prisma.changelogEntry.deleteMany({ where: { id, workspaceId } });
  return NextResponse.json({ ok: true });
}
