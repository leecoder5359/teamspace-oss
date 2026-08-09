import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { loadAccess, visibleOnly } from "@/lib/pageGuard";
import { computeGraph } from "@/lib/wikilink";

export const runtime = "nodejs";

// GET /api/graph → 위키 그래프(노드=문서, 간선=[[링크]])
export async function GET() {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const pages = await prisma.page.findMany({
    where: { workspaceId, kind: "doc", deletedAt: null },
    select: { id: true, title: true, markdown: true },
  });
  // D3: 그래프·점검도 제목과 링크 관계를 드러낸다 — 볼 수 있는 것만 넣는다.
  const idx = await loadAccess(guard);
  return NextResponse.json(computeGraph(visibleOnly(idx, pages)));
}
