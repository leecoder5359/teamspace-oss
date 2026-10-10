import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveProjectRef } from "@/lib/projectRef";
import { requireCtx } from "@/lib/workspace";
import { parseLessonStack } from "@/lib/lessonInject";
import { recordLessonRead } from "@/lib/lessonInspect/log";

export const runtime = "nodejs";

// GET /api/lessons/[id] → { lesson } — 세션 주입(compact)은 제목·요약만 넣으므로 전문은 여기서 읽는다.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("viewer");
  if ("err" in guard) return guard.err;
  const lesson = await prisma.lesson.findUnique({ where: { id } });
  if (!lesson || lesson.workspaceId !== guard.workspaceId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // 에이전트의 전문 조회(MCP lesson_get·pnpm ws lesson show)를 센다 — 레슨 주입 점검의 '조회 수'. fire-and-forget.
  if (guard.actor?.type === "agent") void recordLessonRead({ workspaceId: guard.workspaceId, lessonId: lesson.id, actorName: guard.actor.name });
  return NextResponse.json({ lesson });
}

// PATCH /api/lessons/[id] { title?, body?, projectId?, stack? } — 범위는 셋 중 하나: 전역(둘 다 null) · 프로젝트 · 스택
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const lesson = await prisma.lesson.findUnique({ where: { id } });
  if (!lesson || lesson.workspaceId !== guard.workspaceId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    body?: string;
    projectId?: string | null;
    stack?: string | null;
  };
  const data: { title?: string; body?: string; projectId?: string | null; stack?: string | null } = {};
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
  // 범위는 하나만: 한쪽을 새로 정하면 다른 쪽은 비운다. 둘 다 값을 주면 거절한다.
  if (data.projectId && data.stack) {
    return NextResponse.json({ error: "레슨 범위는 프로젝트와 스택 중 하나만 정할 수 있습니다." }, { status: 400 });
  }
  if (data.projectId) data.stack = null;
  if (data.stack) data.projectId = null;
  const updated = await prisma.lesson.update({ where: { id }, data });
  return NextResponse.json({ lesson: updated });
}

// DELETE /api/lessons/[id]
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const lesson = await prisma.lesson.findUnique({ where: { id } });
  if (!lesson || lesson.workspaceId !== guard.workspaceId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  await prisma.lesson.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

