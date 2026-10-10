import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import type { Role } from "@/app/generated/prisma/enums";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";

const MemberPatchBody = z.object({
  role: z.string().optional(),
  teamId: z.string().nullable().optional(),
});

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

  const parsed = await readBody(req, MemberPatchBody);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  const data: { role?: Role; teamId?: string | null } = {};

  // 역할 변경
  if (body.role !== undefined) {
    if (!VALID_ROLES.includes(body.role as Role)) {
      return NextResponse.json({ error: "유효하지 않은 역할입니다." }, { status: 400 });
    }
    // 마지막 관리자 강등 방지
    //
    // status:"active" 가 필수다. 제거는 소프트(아래 DELETE 가 status="removed" 로 두고
    // role 은 admin 그대로 남긴다)라, 관리자를 한 번이라도 제거한 워크스페이스에는
    // 유령 admin 행이 남는다. 그걸 세면 활성 관리자가 1명뿐인데도 2명으로 보여
    // 마지막 관리자 강등이 통과하고, 그 순간 admin 전용 라우트가 전부 잠긴다
    // (자동 가입은 editor 라 자가복구 경로가 없다 — lib/workspace.ts:86-89).
    // 15줄 아래 DELETE 와 approvals 라우트는 이미 active 로 세고 있었다.
    if (member.role === "admin" && body.role !== "admin") {
      const adminCount = await prisma.workspaceMember.count({
        where: { workspaceId, role: "admin", status: "active" },
      });
      if (adminCount <= 1) {
        return NextResponse.json({ error: "마지막 관리자의 역할은 변경할 수 없습니다." }, { status: 400 });
      }
    }
    data.role = body.role as Role;
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
