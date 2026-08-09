import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { loadAccess, visibleOnly } from "@/lib/pageGuard";

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
  // D3: 지운다고 안 보이던 게 보이게 되면 안 된다.
  const idx = await loadAccess(guard);
  return NextResponse.json({ pages: visibleOnly(idx, pages) });
}
