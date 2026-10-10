import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { loadAccess, visibleOnly } from "@/lib/pageGuard";
import { computeLint } from "@/lib/wikilink";

export const runtime = "nodejs";

// GET /api/lint → 위키 점검(깨진 링크 + 고아 문서)
export async function GET() {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const pages = await prisma.page.findMany({
    where: { workspaceId, kind: "doc", deletedAt: null },
    select: { id: true, title: true, markdown: true, parentId: true, projectId: true, docType: true },
  });
  // D3: 그래프·점검도 제목과 링크 관계를 드러낸다 — 볼 수 있는 것만 넣는다.
  const idx = await loadAccess(guard);
  return NextResponse.json(computeLint(visibleOnly(idx, pages)));
}
