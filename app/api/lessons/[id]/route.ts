import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveProjectRef } from "@/lib/projectRef";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

// PATCH /api/lessons/[id] { title?, body?, projectId? }
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
  };
  const data: { title?: string; body?: string; projectId?: string | null } = {};
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
