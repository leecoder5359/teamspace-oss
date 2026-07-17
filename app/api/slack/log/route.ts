import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

// GET /api/slack/log?kind=&limit= → 알림 발송 내역(최신순) + 요약 카운트
export async function GET(request: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind"); // manual|approval|reminder|test
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 300);

  // due_marker 는 내부 중복 방지 마커 — 발송 이력에 노출하지 않는다 (W6)
  const where = { workspaceId, kind: kind && kind !== "all" ? kind : { not: "due_marker" } };
  const [logs, total, failed] = await Promise.all([
    prisma.notifLog.findMany({ where, orderBy: { createdAt: "desc" }, take: limit }),
    prisma.notifLog.count({ where: { workspaceId, kind: { not: "due_marker" } } }),
    prisma.notifLog.count({ where: { workspaceId, state: "failed" } }),
  ]);

  // 오늘(서버 로컬 기준) 전송 성공 건수
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const sentToday = await prisma.notifLog.count({
    where: { workspaceId, state: "sent", kind: { not: "due_marker" }, createdAt: { gte: start } },
  });

  return NextResponse.json({ logs, total, failed, sentToday });
}
