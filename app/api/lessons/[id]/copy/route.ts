import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { copyDecision, withLessonMeta } from "@/lib/lessonAccess";
import { viewerPersonId } from "@/lib/viewerPerson";

export const runtime = "nodejs";

// POST /api/lessons/[id]/copy → { lesson } — 팀원의 공개 개인 레슨을 내 개인 레슨으로 복사(title·body·mode·keywords).
// 이후 원본과 독립(구독 아님). 같은 원본을 이미 가져왔으면 409 { error, lessonId }.
// 팀원 탭에 보이는 것만 가져온다: 남의 비공개·작성자가 빠진 레슨·가져온 복사본은 404(admin 도). 내 레슨·팀 레슨은 400.
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const personId = viewerPersonId(guard);
  const src = await prisma.lesson.findUnique({ where: { id } });
  if (!src || src.workspaceId !== guard.workspaceId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const author = src.userId
    ? await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId: guard.workspaceId, userId: src.userId } },
        select: { status: true },
      })
    : null;
  const d = copyDecision(src, { personId, role: guard.role }, author?.status === "active");
  if (d === "not_found") return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (d === "own") return NextResponse.json({ error: "내 레슨은 가져올 수 없습니다." }, { status: 400 });
  if (d === "team") {
    return NextResponse.json({ error: "팀 레슨은 이미 범위 안의 모든 세션에 주입됩니다 — 가져올 필요가 없습니다." }, { status: 400 });
  }
  const me = personId as string;
  const existing = () =>
    prisma.lesson.findFirst({ where: { workspaceId: guard.workspaceId, userId: me, copiedFromId: src.id }, select: { id: true } });
  const dup = await existing();
  if (dup) return NextResponse.json({ error: "이미 가져온 레슨입니다.", lessonId: dup.id }, { status: 409 });
  try {
    const lesson = await prisma.lesson.create({
      data: {
        workspaceId: guard.workspaceId,
        userId: me,
        copiedFromId: src.id,
        title: src.title,
        body: src.body,
        mode: src.mode,
        keywords: src.keywords,
        createdById: guard.userId,
      },
    });
    return NextResponse.json({ lesson: withLessonMeta(lesson) });
  } catch (e) {
    // 동시 요청 경쟁 — @@unique([workspaceId, userId, copiedFromId]) 가 막는다
    if ((e as { code?: string }).code === "P2002") {
      const again = await existing();
      return NextResponse.json({ error: "이미 가져온 레슨입니다.", lessonId: again?.id ?? null }, { status: 409 });
    }
    throw e;
  }
}
