import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

// GET /api/sessions → 워크스페이스 Claude 세션 목록(+아이템 수). 인입은 M4 후속.
export async function GET() {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const sessions = await prisma.claudeSession.findMany({
    where: { workspaceId },
    orderBy: { startedAt: "desc" },
    take: 100,
    select: {
      id: true,
      externalId: true,
      project: true,
      cwd: true,
      status: true,
      startedAt: true,
      endedAt: true,
      _count: { select: { items: true } },
    },
  });
  return NextResponse.json({ sessions });
}
