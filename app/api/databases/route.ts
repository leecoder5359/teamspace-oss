import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { createTaskDatabase } from "@/lib/taskdb";

// POST /api/databases → 태스크 보드(template) 생성. projectId 지정 시 해당 프로젝트에 연결.
export async function POST(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId, userId } = guard;
  const body = (await request.json().catch(() => ({}))) as {
    title?: string;
    parentId?: string | null;
    projectId?: string | null;
  };
  const title = body.title?.trim() || "태스크 보드";

  // projectId 지정 시 동일 워크스페이스 프로젝트인지 검증
  let projectId: string | null = null;
  if (body.projectId) {
    const project = await prisma.project.findUnique({
      where: { id: body.projectId },
      select: { workspaceId: true },
    });
    if (!project || project.workspaceId !== workspaceId) {
      return NextResponse.json({ error: "프로젝트를 찾을 수 없습니다." }, { status: 400 });
    }
    projectId = body.projectId;
  }

  const page = await createTaskDatabase(workspaceId, userId, title, body.parentId ?? null, projectId);
  return NextResponse.json({
    page: { id: page.id, title: page.title, parentId: page.parentId, kind: page.kind, projectId },
  });
}
