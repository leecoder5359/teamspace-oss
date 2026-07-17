import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

// GET /api/lessons[?projectId=] → 팀 레슨/작업규칙 목록 (전역 + 프로젝트)
export async function GET(req: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const projectId = new URL(req.url).searchParams.get("projectId");
  const lessons = await prisma.lesson.findMany({
    where: {
      workspaceId: guard.workspaceId,
      ...(projectId ? { OR: [{ projectId }, { projectId: null }] } : {}),
    },
    orderBy: [{ projectId: "asc" }, { updatedAt: "desc" }],
  });
  return NextResponse.json({ lessons });
}

// POST /api/lessons { title, body, projectId? } → 레슨 등록 (컨텍스트 주입에 포함됨)
export async function POST(req: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    body?: string;
    projectId?: string | null;
  };
  const title = body.title?.trim() ?? "";
  const text = body.body?.trim() ?? "";
  if (!title || !text) {
    return NextResponse.json({ error: "title 과 body 가 필요합니다." }, { status: 400 });
  }
  if (body.projectId) {
    const project = await prisma.project.findUnique({ where: { id: body.projectId }, select: { workspaceId: true } });
    if (!project || project.workspaceId !== guard.workspaceId) {
      return NextResponse.json({ error: "프로젝트를 찾을 수 없습니다." }, { status: 400 });
    }
  }
  const lesson = await prisma.lesson.create({
    data: {
      workspaceId: guard.workspaceId,
      projectId: body.projectId ?? null,
      title,
      body: text,
      createdById: guard.userId,
    },
  });
  return NextResponse.json({ lesson });
}
