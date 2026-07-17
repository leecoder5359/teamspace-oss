import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { computeBacklinks } from "@/lib/wikilink";

export const runtime = "nodejs";

// GET /api/pages/[id]/backlinks → 이 페이지를 [[제목]]으로 참조하는 문서들
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const pages = await prisma.page.findMany({
    where: { workspaceId, kind: "doc", deletedAt: null },
    select: { id: true, title: true, markdown: true },
  });
  const back = computeBacklinks(pages);
  return NextResponse.json({ backlinks: back[id] ?? [] });
}
