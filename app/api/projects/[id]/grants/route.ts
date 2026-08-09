import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { requireProject, canManageProjectGrants } from "@/lib/pageGuard";
import { recordActivity, pushNotification } from "@/lib/activity";

export const runtime = "nodejs";

/* =====================================================================
   프로젝트 공유 범위 (격차 D3) — 페이지 쪽(/api/pages/[id]/grants)과 같은 모양.

   프로젝트를 잠그면 그 프로젝트에 속한 페이지 전체가 잠긴다. 페이지 하나하나
   잠그는 것보다 이쪽이 실제 쓰임에 가깝다("이 프로젝트는 아직 우리 팀만").
   페이지 부여가 프로젝트 잠금보다 우선하므로, 잠근 프로젝트 안에서 문서 하나만
   따로 공유하는 것도 된다.
   ===================================================================== */

type Body = {
  userId?: string | null;
  teamId?: string | null;
  level?: "view" | "edit";
  visibility?: "inherit" | "restricted";
};

async function gate(id: string, min: "view" | "edit") {
  const guard = await requireCtx(min === "edit" ? "editor" : "viewer");
  if ("err" in guard) return { err: guard.err };
  const project = await prisma.project.findFirst({
    where: { id, workspaceId: guard.workspaceId },
    select: { id: true, name: true, visibility: true },
  });
  if (!project) return { err: NextResponse.json({ error: "프로젝트를 찾을 수 없습니다." }, { status: 404 }) };
  const g = await requireProject(guard, id, min);
  if ("err" in g) return { err: g.err };
  return { guard, idx: g.idx, project };
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const g = await gate(id, "view");
  if ("err" in g) return g.err;

  const grants = await prisma.projectGrant.findMany({
    where: { projectId: id },
    select: {
      id: true,
      level: true,
      createdAt: true,
      user: { select: { id: true, name: true, email: true } },
      team: { select: { id: true, name: true, color: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({
    visibility: g.project.visibility,
    grants,
    canManage: canManageProjectGrants(g.idx, id),
    adminBypass: true,
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const g = await gate(id, "edit");
  if ("err" in g) return g.err;
  const body = (await req.json().catch(() => ({}))) as Body;
  if (body.visibility !== "inherit" && body.visibility !== "restricted") {
    return NextResponse.json({ error: "visibility 는 inherit 또는 restricted 입니다." }, { status: 400 });
  }
  const project = await prisma.project.update({
    where: { id },
    data: { visibility: body.visibility },
    select: { name: true, visibility: true },
  });

  // 페이지 쪽과 같은 이유로 자기 잠금 방지 — 잠근 사람에게 편집 부여를 남긴다.
  if (body.visibility === "restricted" && g.guard.role !== "admin") {
    await prisma.projectGrant
      .upsert({
        where: { projectId_userId: { projectId: id, userId: g.guard.userId } },
        create: { projectId: id, userId: g.guard.userId, level: "edit", createdById: g.guard.userId },
        update: { level: "edit" },
      })
      .catch(() => {});
  }
  recordActivity(
    g.guard,
    body.visibility === "restricted" ? "비공개로 전환" : "공개로 전환",
    "project",
    project.name,
    id,
  );
  return NextResponse.json({ ok: true, visibility: project.visibility });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const g = await gate(id, "edit");
  if ("err" in g) return g.err;
  const { workspaceId } = g.guard;
  const body = (await req.json().catch(() => ({}))) as Body;
  const level = body.level === "edit" ? "edit" : "view";
  const userId = body.userId?.trim() || null;
  const teamId = body.teamId?.trim() || null;

  if ((userId && teamId) || (!userId && !teamId)) {
    return NextResponse.json({ error: "userId 또는 teamId 중 하나만 지정하세요." }, { status: 400 });
  }
  if (userId) {
    const member = await prisma.workspaceMember.findFirst({
      where: { workspaceId, userId, status: "active" },
      select: { userId: true },
    });
    if (!member) return NextResponse.json({ error: "이 워크스페이스의 활성 멤버가 아닙니다." }, { status: 400 });
  }
  if (teamId) {
    const team = await prisma.team.findFirst({ where: { id: teamId, workspaceId }, select: { id: true } });
    if (!team) return NextResponse.json({ error: "팀을 찾을 수 없습니다." }, { status: 400 });
  }

  const where = userId
    ? { projectId_userId: { projectId: id, userId } }
    : { projectId_teamId: { projectId: id, teamId: teamId! } };
  const grant = await prisma.projectGrant.upsert({
    where,
    create: { projectId: id, userId, teamId, level, createdById: g.guard.userId },
    update: { level },
    select: {
      id: true,
      level: true,
      user: { select: { id: true, name: true, email: true } },
      team: { select: { id: true, name: true, color: true } },
    },
  });

  recordActivity(g.guard, "공유함", "project", `${g.project.name} → ${grant.user?.name ?? grant.team?.name ?? ""}`, id);
  if (userId) {
    void pushNotification(workspaceId, [userId], "shared", `🔓 프로젝트 공유: ${g.project.name}`, `/projects`, g.guard.userId);
  }
  return NextResponse.json({ ok: true, grant });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const g = await gate(id, "edit");
  if ("err" in g) return g.err;
  const grantId = new URL(req.url).searchParams.get("grantId");
  if (!grantId) return NextResponse.json({ error: "grantId 가 필요합니다." }, { status: 400 });

  const grant = await prisma.projectGrant.findFirst({ where: { id: grantId, projectId: id }, select: { id: true } });
  if (!grant) return NextResponse.json({ error: "부여를 찾을 수 없습니다." }, { status: 404 });
  await prisma.projectGrant.delete({ where: { id: grantId } });

  recordActivity(g.guard, "공유 회수", "project", g.project.name, id);
  return NextResponse.json({ ok: true });
}
