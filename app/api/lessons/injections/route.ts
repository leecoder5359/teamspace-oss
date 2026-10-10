import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { personalLessonWhere } from "@/lib/lessonAccess";
import { viewerPersonId } from "@/lib/viewerPerson";
import { injectionStats } from "@/lib/lessonInspect/analyze";
import { LESSON_LOG_RETENTION_DAYS, maybePurge } from "@/lib/lessonInspect/log";

export const runtime = "nodejs";

const MAX_ROWS = 20_000;

/**
 * GET /api/lessons/injections?days=30 → 레슨 주입 기록 집계(편집자 이상, 1~90일).
 *   totals · byProject(최근 7일 / 기간) · recent(최근 20건) · lessons(레슨별 요약·제목만·잘림 횟수와 에이전트 조회 수)
 *   cleanup: alwaysTruncated(기간 중 요약으로 한 번도 안 들어감) · neverInjected(기간 중 대상이 된 적 없음) · similarTitles(제목 자카드 ≥0.6)
 *   기록이 하나도 없으면 alwaysTruncated·neverInjected 는 비운다(판단 근거 없음).
 */
export async function GET(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  // 개인 레슨은 본인(토큰이면 발급자) 것만 — admin 은 관리용으로 모두
  const personal = personalLessonWhere({ personId: viewerPersonId(guard), role: guard.role });
  const raw = Number(new URL(request.url).searchParams.get("days") ?? 30);
  const days = Number.isFinite(raw) ? Math.min(LESSON_LOG_RETENTION_DAYS, Math.max(1, Math.round(raw))) : 30;
  const since = new Date(Date.now() - days * 86_400_000);
  void maybePurge();

  const [rows, reads, lessons, projects] = await Promise.all([
    prisma.lessonInjection.findMany({
      where: { workspaceId, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      take: MAX_ROWS,
      select: { id: true, createdAt: true, actorName: true, cwd: true, projectId: true, via: true, mode: true, gistIds: true, titleIds: true, omittedIds: true, chars: true },
    }),
    prisma.lessonRead.findMany({ where: { workspaceId, createdAt: { gte: since } }, select: { lessonId: true }, take: MAX_ROWS }),
    prisma.lesson.findMany({
      where: { workspaceId, ...(personal ? { AND: [personal] } : {}) },
      orderBy: { updatedAt: "desc" },
      select: { id: true, title: true, projectId: true, stack: true, userId: true, mode: true, createdAt: true },
      take: 500,
    }),
    prisma.project.findMany({ where: { workspaceId, archivedAt: null }, select: { id: true, name: true } }),
  ]);

  const stats = injectionStats({ rows, reads, lessons, projects, days });
  return NextResponse.json({ ...stats, truncated: rows.length >= MAX_ROWS }, { headers: { "Cache-Control": "no-store" } });
}
