import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

// GET /api/activity[?limit=&type=&actor=] → 워크스페이스 활동 피드 (최신순)
export async function GET(req: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 40, 200);
  const type = url.searchParams.get("type");
  const actor = url.searchParams.get("actor");

  const activities = await prisma.activity.findMany({
    where: {
      workspaceId: guard.workspaceId,
      ...(type ? { targetType: type } : {}),
      ...(actor ? { actorName: actor } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return NextResponse.json({ activities });
}
