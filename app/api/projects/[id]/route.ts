import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

const COLORS = ["blue", "orange", "purple", "green", "red", "gray"];

// PATCH /api/projects/[id] → 이름/코드/색상/설명/리드 수정
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;

  const project = await prisma.project.findUnique({ where: { id } });
  if (!project || project.workspaceId !== workspaceId) {
    return NextResponse.json({ error: "프로젝트를 찾을 수 없습니다." }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    short?: string | null;
    color?: string;
    description?: string | null;
    leadId?: string | null;
    repoUrl?: string | null;
    repoPath?: string | null;
    repoBranch?: string | null;
    docsDir?: string | null;
  };

  const data: Record<string, unknown> = {};
  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (!name) return NextResponse.json({ error: "이름은 비울 수 없습니다." }, { status: 400 });
    data.name = name;
  }
  if (body.short !== undefined) data.short = body.short?.trim() || null;
  if (body.description !== undefined) data.description = body.description?.trim() || null;
  if (body.color !== undefined && COLORS.includes(body.color)) data.color = body.color;
  if (body.repoUrl !== undefined) data.repoUrl = body.repoUrl?.trim() || null;
  if (body.repoPath !== undefined) data.repoPath = body.repoPath?.trim() || null;
  if (body.repoBranch !== undefined) data.repoBranch = body.repoBranch?.trim() || null;
  if (body.docsDir !== undefined) data.docsDir = body.docsDir?.trim() || null;
  if (body.leadId !== undefined) {
    if (body.leadId === null) {
      data.leadId = null;
    } else {
      const member = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: body.leadId } },
      });
      data.leadId = member ? body.leadId : null;
    }
  }

  const updated = await prisma.project.update({ where: { id }, data });
  return NextResponse.json({ project: updated });
}

// DELETE /api/projects/[id] → 프로젝트 삭제 (소속 페이지는 projectId만 해제: SetNull)
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;

  const project = await prisma.project.findUnique({ where: { id } });
  if (!project || project.workspaceId !== workspaceId) {
    return NextResponse.json({ error: "프로젝트를 찾을 수 없습니다." }, { status: 404 });
  }

  await prisma.project.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
