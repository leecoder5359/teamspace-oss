import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

const COLORS = ["blue", "orange", "purple", "green", "red", "gray"];

// PATCH /api/teams/[id] → 이름/색 변경 { name?, color? }
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const team = await prisma.team.findUnique({ where: { id } });
  if (!team || team.workspaceId !== workspaceId) {
    return NextResponse.json({ error: "팀을 찾을 수 없습니다." }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as { name?: string; color?: string };
  const data: { name?: string; color?: string } = {};
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return NextResponse.json({ error: "팀 이름을 입력해 주세요." }, { status: 400 });
    data.name = name;
  }
  if (body.color !== undefined && COLORS.includes(body.color)) data.color = body.color;
  const updated = await prisma.team.update({ where: { id }, data });
  return NextResponse.json({ team: { id: updated.id, name: updated.name, color: updated.color } });
}

// DELETE /api/teams/[id] → 팀 삭제 (멤버의 teamId 는 SetNull 로 해제됨)
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const team = await prisma.team.findUnique({ where: { id } });
  if (!team || team.workspaceId !== workspaceId) {
    return NextResponse.json({ error: "팀을 찾을 수 없습니다." }, { status: 404 });
  }
  await prisma.team.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
