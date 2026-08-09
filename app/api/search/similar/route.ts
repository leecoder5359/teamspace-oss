import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { loadAccess, visibleOnly, pageAccess } from "@/lib/pageGuard";
import { buildIndex, similarTo, searchVectors } from "@/lib/vector";

export const runtime = "nodejs";

/* =====================================================================
   GET /api/search/similar?pageId=<id>   → 이 문서와 비슷한 문서
   GET /api/search/similar?q=<질의>       → 벡터 유사도로 찾기 (격차 G2)

   **정직하게**: 신경망 임베딩이 아니라 TF-IDF 코사인이다(lib/vector.ts 주석 참고).
   글자가 겹치지 않는 동의어는 못 잇는다 — 그건 개념검색(`/api/search/concept`,
   LLM 질의확장)이 맡는다. 대신 여기서만 되는 게 있다: **질의어 없이 문서 자체로
   이웃을 찾는 것**. 응답의 `mode` 로 어느 방식인지 밝힌다.

   색인은 요청마다 만든다. 수백 개 규모에서는 수십 ms 라 캐시가 오히려 부담이고,
   무엇보다 **문서를 고치자마자 반영된다**(캐시는 낡을 수 있다). 규모가 커지면
   그때 캐시나 진짜 임베딩으로 옮긴다.
   ===================================================================== */

export async function GET(req: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const sp = new URL(req.url).searchParams;
  const pageId = sp.get("pageId")?.trim();
  const q = sp.get("q")?.trim();
  const limit = Math.min(20, Math.max(1, Number(sp.get("limit") ?? 5) || 5));

  if (!pageId && !q) {
    return NextResponse.json({ error: "pageId 또는 q 가 필요합니다." }, { status: 400 });
  }

  const pages = await prisma.page.findMany({
    where: { workspaceId: guard.workspaceId, kind: "doc", deletedAt: null },
    select: { id: true, title: true, markdown: true, project: { select: { name: true } } },
  });

  // D3: 못 보는 문서는 색인에도 넣지 않는다 — 유사도 목록은 제목을 그대로 드러낸다.
  const idx0 = await loadAccess(guard);
  const visible = visibleOnly(idx0, pages);

  // 기준 문서 자체도 볼 수 있어야 한다.
  if (pageId && pageAccess(idx0, pageId) === "none") {
    return NextResponse.json({ error: "페이지를 찾을 수 없습니다." }, { status: 404 });
  }

  const index = buildIndex(visible.map((p) => ({ id: p.id, title: p.title, text: p.markdown ?? "" })));
  const hits = pageId ? similarTo(index, pageId, limit) : searchVectors(index, q!, limit);
  const byId = new Map(visible.map((p) => [p.id, p]));

  return NextResponse.json({
    mode: pageId ? "similar" : "query",
    // 무엇으로 계산했는지 밝힌다 — '임베딩'이라고 믿게 두면 동의어가 안 잡힐 때 버그로 보인다.
    method: "tfidf-cosine",
    indexed: visible.length,
    results: hits.map((h) => {
      const p = byId.get(h.id)!;
      return {
        id: h.id,
        title: p.title,
        project: p.project?.name ?? null,
        score: Math.round(h.score * 1000) / 1000,
      };
    }),
  });
}
