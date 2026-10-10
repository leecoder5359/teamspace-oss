import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveProjectRef } from "@/lib/projectRef";
import { requireCtx } from "@/lib/workspace";
import { parseLessonMode, parseLessonStack, type LessonMode } from "@/lib/lessonInject";
import { recordLessonRead } from "@/lib/lessonInspect/log";
import { canSeeLesson, withLessonMeta, PERSONAL_NEEDS_PERSON, PERSONAL_SCOPE_CONFLICT } from "@/lib/lessonAccess";
import { viewerPersonId } from "@/lib/viewerPerson";

export const runtime = "nodejs";

// GET /api/lessons/[id] → { lesson } — 세션 주입(compact)은 제목·요약만 넣으므로 전문은 여기서 읽는다.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("viewer");
  if ("err" in guard) return guard.err;
  const lesson = await prisma.lesson.findUnique({ where: { id } });
  // 다른 사람의 개인 레슨은 없는 것으로(admin 은 관리용으로 읽을 수 있다)
  if (!lesson || lesson.workspaceId !== guard.workspaceId || !canSeeLesson(lesson, { personId: viewerPersonId(guard), role: guard.role })) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // 에이전트의 전문 조회(MCP lesson_get·pnpm ws lesson show)를 센다 — 레슨 주입 점검의 '조회 수'. fire-and-forget.
  if (guard.actor?.type === "agent") void recordLessonRead({ workspaceId: guard.workspaceId, lessonId: lesson.id, actorName: guard.actor.name });
  return NextResponse.json({ lesson: withLessonMeta(lesson) });
}

// PATCH /api/lessons/[id] { title?, body?, projectId?, stack?, personal?, mode? }
// 범위는 넷 중 하나: 전역(모두 null) · 프로젝트 · 스택 · 개인(personal:true → 요청한 사람, 에이전트 토큰이면 발급자).
// 한쪽을 새로 정하면 나머지는 비운다. personal:true 를 projectId·stack 과 함께 주면 거절한다. personal:false = 개인 해제(전역으로).
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const personId = viewerPersonId(guard);
  const lesson = await prisma.lesson.findUnique({ where: { id } });
  if (!lesson || lesson.workspaceId !== guard.workspaceId || !canSeeLesson(lesson, { personId, role: guard.role })) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    body?: string;
    projectId?: string | null;
    stack?: string | null;
    personal?: boolean;
    mode?: string;
  };
  const data: { title?: string; body?: string; projectId?: string | null; stack?: string | null; userId?: string | null; mode?: LessonMode } = {};
  if (body.title !== undefined) {
    const t = body.title.trim();
    if (!t) return NextResponse.json({ error: "title 이 비었습니다." }, { status: 400 });
    data.title = t;
  }
  if (body.body !== undefined) {
    const b = body.body.trim();
    if (!b) return NextResponse.json({ error: "body 가 비었습니다." }, { status: 400 });
    data.body = b;
  }
  if (body.projectId !== undefined) {
    // POST(lessons/route.ts)는 400 으로 거절하는데 PATCH 는 무검증이었다 — 같은 규칙으로(D5)
    const ref = await resolveProjectRef(body.projectId, guard.workspaceId);
    if (!ref.ok) return ref.err;
    data.projectId = ref.projectId;
  }
  if (body.stack !== undefined) {
    const st = parseLessonStack(body.stack);
    if (!st.ok) return NextResponse.json({ error: st.error }, { status: 400 });
    data.stack = st.stack;
  }
  if (body.mode !== undefined) {
    const md = parseLessonMode(body.mode);
    if (!md.ok) return NextResponse.json({ error: md.error }, { status: 400 });
    data.mode = md.mode;
  }
  if (body.personal !== undefined && typeof body.personal !== "boolean") {
    return NextResponse.json({ error: "personal 은 true/false 입니다." }, { status: 400 });
  }
  // 범위는 하나만: 한쪽을 새로 정하면 다른 쪽은 비운다. 둘 이상에 값을 주면 거절한다.
  if (data.projectId && data.stack) {
    return NextResponse.json({ error: "레슨 범위는 프로젝트와 스택 중 하나만 정할 수 있습니다." }, { status: 400 });
  }
  if (body.personal === true) {
    if (data.projectId || data.stack) return NextResponse.json({ error: PERSONAL_SCOPE_CONFLICT }, { status: 400 });
    if (!personId) return NextResponse.json({ error: PERSONAL_NEEDS_PERSON }, { status: 400 });
    data.userId = personId;
    data.projectId = null;
    data.stack = null;
  } else if (body.personal === false) {
    data.userId = null;
  }
  if (data.projectId) {
    data.stack = null;
    data.userId = null;
  }
  if (data.stack) {
    data.projectId = null;
    data.userId = null;
  }
  const updated = await prisma.lesson.update({ where: { id }, data });
  return NextResponse.json({ lesson: withLessonMeta(updated) });
}

// DELETE /api/lessons/[id]
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const lesson = await prisma.lesson.findUnique({ where: { id } });
  if (!lesson || lesson.workspaceId !== guard.workspaceId || !canSeeLesson(lesson, { personId: viewerPersonId(guard), role: guard.role })) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  await prisma.lesson.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

