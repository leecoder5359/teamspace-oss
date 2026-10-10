import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { parseLessonStack } from "@/lib/lessonInject";
import { clampLessonLimit, normalizeLessonQ, lessonTitleWhere } from "@/lib/lessonQuery";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";

const LessonBody = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  projectId: z.string().nullable().optional(),
  stack: z.string().nullable().optional(),
});

export const runtime = "nodejs";

// GET /api/lessons[?projectId=&q=&limit=] → 팀 레슨/작업규칙 목록 (전역 + 프로젝트)
// q = 제목 부분일치(대소문자 무시), limit = 1..300(생략하면 전체 — 자사 UI 호환). 응답 { lessons, total } — total 은 limit 앞의 건수.
export async function GET(req: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const sp = new URL(req.url).searchParams;
  const projectId = sp.get("projectId");
  const q = normalizeLessonQ(sp.get("q"));
  const limit = clampLessonLimit(sp.get("limit"));
  const where = {
    workspaceId: guard.workspaceId,
    ...(projectId ? { OR: [{ projectId }, { projectId: null }] } : {}),
    ...lessonTitleWhere(q),
  };
  const [lessons, total] = await Promise.all([
    prisma.lesson.findMany({
      where,
      orderBy: [{ projectId: "asc" }, { updatedAt: "desc" }],
      ...(limit ? { take: limit } : {}),
    }),
    prisma.lesson.count({ where }),
  ]);
  return NextResponse.json({ lessons, total });
}

// POST /api/lessons { title, body, projectId?, stack? } → 레슨 등록 (컨텍스트 주입에 포함됨)
export async function POST(req: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const parsed = await readBody(req, LessonBody);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
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
  const st = parseLessonStack(body.stack ?? null);
  if (!st.ok) return NextResponse.json({ error: st.error }, { status: 400 });
  if (st.stack && body.projectId) {
    return NextResponse.json({ error: "레슨 범위는 프로젝트와 스택 중 하나만 정할 수 있습니다." }, { status: 400 });
  }
  const lesson = await prisma.lesson.create({
    data: {
      workspaceId: guard.workspaceId,
      projectId: body.projectId ?? null,
      stack: st.stack,
      title,
      body: text,
      createdById: guard.userId,
    },
  });
  return NextResponse.json({ lesson });
}
