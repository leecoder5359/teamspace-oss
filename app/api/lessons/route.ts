import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { parseLessonMode, parseLessonStack } from "@/lib/lessonInject";
import { clampLessonLimit, normalizeLessonQ, lessonTitleWhere } from "@/lib/lessonQuery";
import { personalLessonWhere, withLessonMeta, PERSONAL_NEEDS_PERSON, PERSONAL_SCOPE_CONFLICT } from "@/lib/lessonAccess";
import { viewerPersonId } from "@/lib/viewerPerson";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";

const LessonBody = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  projectId: z.string().nullable().optional(),
  stack: z.string().nullable().optional(),
  /** true = 개인 레슨(userId = 요청한 사람 — 에이전트 토큰이면 발급자) */
  personal: z.boolean().optional(),
  /** required | default | ondemand (생략 = default) */
  mode: z.string().optional(),
});

export const runtime = "nodejs";

// GET /api/lessons[?projectId=&q=&limit=&mode=] → 팀 레슨/작업규칙 목록 (전역 + 프로젝트 + 스택 + 내 개인)
// q = 제목 부분일치(대소문자 무시), limit = 1..300(생략하면 전체 — 자사 UI 호환), mode = required|default|ondemand 로 거르기.
// 개인 레슨은 본인(에이전트 토큰이면 발급자) 것만 — admin 은 관리용으로 모두 본다.
// 응답 { lessons, total } — 각 레슨에 scope(personal|project|stack|global)·personal·mode. total 은 limit 앞의 건수.
export async function GET(req: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const sp = new URL(req.url).searchParams;
  const projectId = sp.get("projectId");
  const q = normalizeLessonQ(sp.get("q"));
  const limit = clampLessonLimit(sp.get("limit"));
  const modeRaw = sp.get("mode");
  const mode = modeRaw ? parseLessonMode(modeRaw) : null;
  if (mode && !mode.ok) return NextResponse.json({ error: mode.error }, { status: 400 });
  const personal = personalLessonWhere({ personId: viewerPersonId(guard), role: guard.role });
  const where = {
    workspaceId: guard.workspaceId,
    ...(projectId ? { OR: [{ projectId }, { projectId: null }] } : {}),
    ...(personal ? { AND: [personal] } : {}),
    ...(mode?.ok ? { mode: mode.mode } : {}),
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
  return NextResponse.json({ lessons: lessons.map(withLessonMeta), total });
}

// POST /api/lessons { title, body, projectId?, stack?, personal?, mode? } → 레슨 등록 (mode 가 ondemand 가 아니면 컨텍스트 주입에 포함됨)
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
  let userId: string | null = null;
  if (body.personal) {
    if (body.projectId || st.stack) return NextResponse.json({ error: PERSONAL_SCOPE_CONFLICT }, { status: 400 });
    userId = viewerPersonId(guard);
    if (!userId) return NextResponse.json({ error: PERSONAL_NEEDS_PERSON }, { status: 400 });
  }
  const md = body.mode === undefined ? null : parseLessonMode(body.mode);
  if (md && !md.ok) return NextResponse.json({ error: md.error }, { status: 400 });
  const lesson = await prisma.lesson.create({
    data: {
      workspaceId: guard.workspaceId,
      projectId: body.projectId ?? null,
      stack: st.stack,
      userId,
      ...(md?.ok ? { mode: md.mode } : {}),
      title,
      body: text,
      createdById: guard.userId,
    },
  });
  return NextResponse.json({ lesson: withLessonMeta(lesson) });
}
