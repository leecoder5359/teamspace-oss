import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { groupNotifications } from "@/lib/notifGroup";

export const runtime = "nodejs";

// GET /api/notifications/digest[?hours=24] → 내 알림 요약 { since, until, total, unread, byType, topGroups(≤5) }
// 본인 알림만 집계하므로 viewer 도 허용(requireCtx 기본). 제목은 알림 자체에 박힌 문자열이라 별도 가시성 필터 불필요.
export async function GET(req: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const raw = Number(new URL(req.url).searchParams.get("hours"));
  const hours = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 24 * 30) : 24;
  const until = new Date();
  const since = new Date(until.getTime() - hours * 3600_000);
  const where = { workspaceId: guard.workspaceId, userId: guard.userId, createdAt: { gte: since } };
  // 집계는 DB 에서 — findMany 상한(1000)에 묶이면 그 이상일 때 total·unread·byType 이 틀린다.
  // 상한 조회는 topGroups(묶음 상위 5개) 계산에만 쓴다.
  const [total, unread, types, rows] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { ...where, readAt: null } }),
    prisma.notification.groupBy({ by: ["type"], where, _count: { _all: true } }),
    prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, take: 1000 }),
  ]);
  const byType: Record<string, number> = {};
  for (const g of types) byType[g.type] = g._count._all;
  return NextResponse.json({
    since: since.toISOString(),
    until: until.toISOString(),
    total,
    unread,
    byType,
    topGroups: groupNotifications(rows, until).sort((a, b) => b.count - a.count).slice(0, 5),
  });
}
