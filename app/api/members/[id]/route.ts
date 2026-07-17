import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import type { Role } from "@/app/generated/prisma/enums";

const VALID_ROLES: Role[] = ["admin", "editor", "viewer"];

// PATCH /api/members/[id] → 역할 변경(마지막 관리자 강등 방지) 또는 팀 배정 { role?, teamId? }
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;

  const member = await prisma.workspaceMember.findUnique({ where: { id } });
  if (!member || member.workspaceId !== workspaceId) {
    return NextResponse.json({ error: "멤버를 찾을 수 없습니다." }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as { role?: Role; teamId?: string | null };
  const data: { role?: Role; teamId?: string | null } = {};

  // 역할 변경
  if (body.role !== undefined) {
    if (!VALID_ROLES.includes(body.role)) {
      return NextResponse.json({ error: "유효하지 않은 역할입니다." }, { status: 400 });
    }
    // 마지막 관리자 강등 방지
    if (member.role === "admin" && body.role !== "admin") {
      const adminCount = await prisma.workspaceMember.count({ where: { workspaceId, role: "admin" } });
      if (adminCount <= 1) {
        return NextResponse.json({ error: "마지막 관리자의 역할은 변경할 수 없습니다." }, { status: 400 });
      }
    }
    data.role = body.role;
  }

  // 팀 배정 (null = 미배정)
  if (body.teamId !== undefined) {
    if (body.teamId !== null) {
      const team = await prisma.team.findUnique({ where: { id: body.teamId } });
      if (!team || team.workspaceId !== workspaceId) {
        return NextResponse.json({ error: "팀을 찾을 수 없습니다." }, { status: 400 });
      }
    }
    data.teamId = body.teamId;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "변경할 내용이 없습니다." }, { status: 400 });
  }

  const updated = await prisma.workspaceMember.update({
    where: { id },
    data,
    include: { user: { select: { id: true, name: true, email: true, image: true } } },
  });
  return NextResponse.json({ member: updated });
}

// DELETE /api/members/[id] → 멤버 제거 (마지막 관리자 제거 방지)
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;

  const member = await prisma.workspaceMember.findUnique({ where: { id } });
  if (!member || member.workspaceId !== workspaceId) {
    return NextResponse.json({ error: "멤버를 찾을 수 없습니다." }, { status: 404 });
  }

  // 마지막 관리자 제거 방지
  if (member.role === "admin") {
    const adminCount = await prisma.workspaceMember.count({
      where: { workspaceId, role: "admin", status: "active" },
    });
    if (adminCount <= 1) {
      return NextResponse.json(
        { error: "마지막 관리자는 제거할 수 없습니다." },
        { status: 400 },
      );
    }
  }

  // 소프트 제거: status="removed" — 자동 가입 로직의 재입장을 차단(감사 auth-4)
  await prisma.workspaceMember.update({ where: { id }, data: { status: "removed", teamId: null } });
  // 에이전트 멤버였다면 해당 토큰도 함께 회수
  await prisma.agentToken.updateMany({
    where: { workspaceId, userId: member.userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return NextResponse.json({ ok: true });
}
