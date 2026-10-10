import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { requirePage, visibleOnly } from "@/lib/pageGuard";
import { computeBacklinks } from "@/lib/wikilink";
import { loadArchivedPageIds, excludeArchived } from "@/lib/pageArchive";

export const runtime = "nodejs";

// GET /api/pages/[id]/backlinks → 이 페이지를 [[제목]]으로 참조하는 문서들
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const gate = await requirePage(guard, id, "view");
  if ("err" in gate) return gate.err;
  const { workspaceId } = guard;
  const pages = await prisma.page.findMany({
    where: { workspaceId, kind: "doc", deletedAt: null },
    select: { id: true, title: true, markdown: true },
  });
  const back = computeBacklinks(pages);
  // 못 보는 문서가 이 문서를 참조한다는 사실 자체가 제목 누출이다. 가시성으로 먼저 거른 뒤 보관 문서를 뺀다(D3).
  const archived = await loadArchivedPageIds(prisma, workspaceId);
  return NextResponse.json({ backlinks: excludeArchived(visibleOnly(gate.idx, back[id] ?? []), archived) });
}
