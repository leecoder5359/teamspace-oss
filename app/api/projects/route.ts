import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { getProjectsWithStats } from "@/lib/projects";

const COLORS = ["blue", "orange", "purple", "green", "red", "gray"];

// GET /api/projects → 현재 워크스페이스 프로젝트 + 카드 지표
export async function GET() {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const projects = await getProjectsWithStats(workspaceId);
  return NextResponse.json({ projects });
}

// POST /api/projects → 프로젝트 생성
export async function POST(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const body = (await request.json().catch(() => ({}))) as {
    name?: string;
    short?: string;
    color?: string;
    description?: string;
    leadId?: string;
    repoUrl?: string;
    repoPath?: string;
    repoBranch?: string;
    docsDir?: string;
  };

  const name = body.name?.trim() ?? "";
  if (!name) {
    return NextResponse.json({ error: "프로젝트 이름을 입력해 주세요." }, { status: 400 });
  }

  const color = body.color && COLORS.includes(body.color) ? body.color : "blue";

  // leadId가 주어지면 해당 워크스페이스 멤버인지 확인
  let leadId: string | null = null;
  if (body.leadId) {
    const member = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: body.leadId } },
    });
    if (member) leadId = body.leadId;
  }

  const last = await prisma.project.findFirst({
    where: { workspaceId },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  const project = await prisma.project.create({
    data: {
      workspaceId,
      name,
      short: body.short?.trim() || null,
      color,
      description: body.description?.trim() || null,
      repoUrl: body.repoUrl?.trim() || null,
      repoPath: body.repoPath?.trim() || null,
      repoBranch: body.repoBranch?.trim() || null,
      docsDir: body.docsDir?.trim() || null,
      leadId,
      position: (last?.position ?? -1) + 1,
    },
  });

  return NextResponse.json({ projectId: project.id });
}
