import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { NOTIF_FILTER_TYPES, maybeAutoReadStaleApprovals, parseNotifTypes, unknownNotifTypes } from "@/lib/notificationsCleanup";
import { readBody } from "@/lib/apiBody";
import { groupNotifications } from "@/lib/notifGroup";
import { z } from "zod";

const NotificationsBody = z.object({
  readAll: z.boolean().optional(),
  // 묶음 단위 읽음 — 본인 알림만 갱신(남의 id 가 섞여도 where 로 걸러진다)
  ids: z.array(z.string().min(1)).min(1).max(500).optional(),
});

export const runtime = "nodejs";

// GET /api/notifications[?unread=1&limit=&type=approval,mention&group=1] → 내 알림 (최신순) + 미읽음 수 + 종류별 미읽음 수
// unread·byType 은 type 필터와 무관하게 전체 미읽음 기준(사이드바 배지·칩 배지용).
// 모르는 type 값은 400 — 조용히 버리면 필터 없는 전체 목록이 "필터된 것처럼" 나간다.
export async function GET(req: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const url = new URL(req.url);
  const unreadOnly = url.searchParams.get("unread") === "1";
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
  const rawType = url.searchParams.get("type");
  const unknown = unknownNotifTypes(rawType);
  if (unknown.length) {
    return NextResponse.json(
      { error: `모르는 알림 종류: ${unknown.join(", ")} (가능: ${NOTIF_FILTER_TYPES.join(", ")})` },
      { status: 400 },
    );
  }
  const types = parseNotifTypes(rawType);

  // 오래된 승인 알림 자동 읽음(워크스페이스별 하루 1회) — 집계 전에 돌아야 배지가 바로 준다
  await maybeAutoReadStaleApprovals(guard.workspaceId);

  const mine = { workspaceId: guard.workspaceId, userId: guard.userId };
  const [notifications, unread, grouped] = await Promise.all([
    prisma.notification.findMany({
      where: {
        ...mine,
        ...(unreadOnly ? { readAt: null } : {}),
        ...(types.length ? { type: { in: types } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.notification.count({ where: { ...mine, readAt: null } }),
    prisma.notification.groupBy({ by: ["type"], where: { ...mine, readAt: null }, _count: { _all: true } }),
  ]);
  const byType: Record<string, number> = {};
  for (const g of grouped) byType[g.type] = g._count._all;
  // group=1: limit 은 묶기 전 원본 건수에 적용(최대 200)
  if (url.searchParams.get("group") === "1") {
    return NextResponse.json({ groups: groupNotifications(notifications), unread, byType });
  }
  return NextResponse.json({ notifications, unread, byType });
}

// POST /api/notifications → 전체 읽음 { readAll: true } 또는 묶음 읽음 { ids: [...] }
export async function POST(req: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const parsed = await readBody(req, NotificationsBody);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  if (body.ids?.length) {
    const r = await prisma.notification.updateMany({
      where: { id: { in: body.ids }, workspaceId: guard.workspaceId, userId: guard.userId, readAt: null },
      data: { readAt: new Date() },
    });
    return NextResponse.json({ ok: true, read: r.count });
  }
  if (!body.readAll) return NextResponse.json({ error: "readAll: true 또는 ids 가 필요합니다." }, { status: 400 });
  const r = await prisma.notification.updateMany({
    where: { workspaceId: guard.workspaceId, userId: guard.userId, readAt: null },
    data: { readAt: new Date() },
  });
  return NextResponse.json({ ok: true, read: r.count });
}
