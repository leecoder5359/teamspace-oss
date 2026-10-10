import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { loadAccess, visibleOnly } from "@/lib/pageGuard";
import { computeLint } from "@/lib/wikilink";
import { loadArchivedPageIds } from "@/lib/pageArchive";

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
  const visible = visibleOnly(idx, pages);
  // 보관 문서(조상 규칙)는 관리 대상이 아니라 보고에서 뺀다. 다만 계산은 보이는 보관 문서까지 넣어서 한다 —
  // 활성 문서가 보관 문서로만 이어지면 고아가 아니고(간선 유지), 보관 자식만 둔 활성 폴더는 뿌리 문서가 아니며,
  // 보관 문서를 가리키는 링크는 깨진 게 아니다(대상이 실재). 그 뒤 모든 목록을 활성 문서로만 거른다.
  const archived = await loadArchivedPageIds(prisma, workspaceId);
  const lint = computeLint(visible);
  if (archived.size === 0) return NextResponse.json(lint);
  return NextResponse.json({
    broken: lint.broken.filter((b) => !archived.has(b.sourceId)),
    orphans: lint.orphans.filter((o) => !archived.has(o.id)),
    rootDocs: lint.rootDocs.filter((r) => !archived.has(r.id)),
  });
}
