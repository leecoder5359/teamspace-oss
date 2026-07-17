import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

// GET /api/trash → 휴지통(소프트 삭제된 페이지) 목록. 최근 삭제순.
export async function GET() {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const pages = await prisma.page.findMany({
    where: { workspaceId: guard.workspaceId, deletedAt: { not: null } },
    select: {
      id: true,
      title: true,
      kind: true,
      deletedAt: true,
      parentId: true,
      project: { select: { id: true, name: true } },
    },
    orderBy: { deletedAt: "desc" },
  });
  return NextResponse.json({ pages });
}
