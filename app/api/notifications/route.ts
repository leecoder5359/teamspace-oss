import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

// GET /api/notifications[?unread=1&limit=] → 내 알림 (최신순) + 미읽음 수
export async function GET(req: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const url = new URL(req.url);
  const unreadOnly = url.searchParams.get("unread") === "1";
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);

  const [notifications, unread] = await Promise.all([
    prisma.notification.findMany({
      where: {
        workspaceId: guard.workspaceId,
        userId: guard.userId,
        ...(unreadOnly ? { readAt: null } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.notification.count({
      where: { workspaceId: guard.workspaceId, userId: guard.userId, readAt: null },
    }),
  ]);
  return NextResponse.json({ notifications, unread });
}

// POST /api/notifications → 전체 읽음 처리 { readAll: true }
export async function POST(req: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const body = (await req.json().catch(() => ({}))) as { readAll?: boolean };
  if (!body.readAll) return NextResponse.json({ error: "readAll: true 만 지원합니다." }, { status: 400 });
  const r = await prisma.notification.updateMany({
    where: { workspaceId: guard.workspaceId, userId: guard.userId, readAt: null },
    data: { readAt: new Date() },
  });
  return NextResponse.json({ ok: true, read: r.count });
}
