import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
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
  return NextResponse.json(computeGraph(pages));
}
