import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { loadAccess, visibleOnly } from "@/lib/pageGuard";
import { loadGraph } from "@/lib/graphLoad";
import { neighbors as graphNeighbors } from "@/lib/graphInsights";
import { rankSearch, usesTrigramIndex, type Candidate, type SearchKind } from "@/lib/searchRank";

export const runtime = "nodejs";

/* =====================================================================
   GET /api/search?q=&projectId=&kind=doc,board,decision&from=&to=&limit=

   격차조사 G1·G3:
   - 종전엔 `ILIKE '%q%'` 로 긁고 **랭킹이 없었다**. 제목 정확일치와 본문
     끄트머리 일치가 동급이라 결과 순서가 사실상 DB 반환 순서였다.
   - 필터도 없어 프로젝트·종류·기간으로 좁힐 수 없었다.

   인덱스: pg_trgm GIN 을 깔았다(마이그레이션 20260808140000). `ILIKE` 가
   인덱스를 탈 수 있게 되어 문서가 늘어도 선형으로 무너지지 않는다.
   ⚠️ 다만 트라이그램은 **3글자 미만 질의에 무력**하다("배포" 같은 2음절은
   여전히 순차 스캔). 응답의 `indexed` 필드로 그 사실을 호출자에게 알린다 —
   느린 이유를 숨기지 않는다.

   랭킹은 DB 가 아니라 lib/searchRank(순수)가 한다. 후보를 넉넉히 받아 거른 뒤
   줄 세운다 — 규모(수백~수천)에선 이게 단순하고 테스트하기도 쉽다.
   ===================================================================== */

const CANDIDATE_TAKE = 300;

export async function GET(request: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;

  const sp = new URL(request.url).searchParams;
  const q = (sp.get("q") ?? "").trim();
  if (!q) return NextResponse.json({ q: "", results: [], docs: [], decisions: [], indexed: false, total: 0 });

  const projectId = sp.get("projectId");
  const from = sp.get("from");
  const to = sp.get("to");
  const limit = Math.min(100, Math.max(1, Number(sp.get("limit") ?? 30) || 30));
  const kinds = (sp.get("kind") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is SearchKind => s === "doc" || s === "board" || s === "decision");

  const ci = { contains: q, mode: "insensitive" as const };
  const wantPages = !kinds.length || kinds.includes("doc") || kinds.includes("board");
  const wantDecisions = !kinds.length || kinds.includes("decision");

  const [pages, decisions] = await Promise.all([
    wantPages
      ? prisma.page.findMany({
          where: { workspaceId, deletedAt: null, OR: [{ title: ci }, { markdown: ci }] },
          select: {
            id: true, title: true, markdown: true, kind: true, updatedAt: true,
            projectId: true, project: { select: { name: true } },
          },
          take: CANDIDATE_TAKE,
        })
      : Promise.resolve([]),
    wantDecisions
      ? prisma.decision.findMany({
          where: { workspaceId, OR: [{ title: ci }, { context: ci }, { decision: ci }] },
          select: { id: true, title: true, context: true, decision: true, projectId: true, createdAt: true },
          take: CANDIDATE_TAKE,
        })
      : Promise.resolve([]),
  ]);

  // D3: 검색은 본문까지 돌려준다 — 여기서 새면 제목이 아니라 내용이 샌다.
  const idx = await loadAccess(guard);
  const candidates: Candidate[] = [
    ...visibleOnly(idx, pages).map((p) => ({
      id: p.id,
      kind: (p.kind === "database" ? "board" : "doc") as SearchKind,
      title: p.title,
      body: p.markdown ?? "",
      projectId: p.projectId,
      projectName: p.project?.name ?? null,
      updatedAt: p.updatedAt,
    })),
    ...decisions.map((d) => ({
      id: d.id,
      kind: "decision" as SearchKind,
      title: d.title,
      body: [d.context, d.decision].filter(Boolean).join(" · "),
      projectId: d.projectId,
      projectName: null,
      updatedAt: d.createdAt,
    })),
  ];

  const results = rankSearch(candidates, q, { projectId, kinds, from, to }, limit);

  // neighbors=1: 상위 결과에 지식 그래프 이웃(제목·관계·근거)을 붙인다 — 에이전트가 문서를 통째로
  // 읽기 전에 주변부터 본다. 권한은 같은 색인(idx)으로 거른 그래프라 새지 않는다.
  // 그래프 로드가 실패해도 검색 자체는 성공해야 하므로 이웃만 생략한다.
  const nb = new Map<string, { id: string; title: string; type: string; kind: string; tag: string }[]>();
  if (sp.get("neighbors") === "1" && results.length) {
    try {
      const g = await loadGraph(guard, idx);
      for (const r of results.slice(0, 5)) {
        nb.set(r.id, graphNeighbors(g, r.id, 1).slice(0, 5).map((n) => ({ id: n.id, title: n.title, type: n.type, kind: n.kind, tag: n.tag })));
      }
    } catch (e) {
      console.warn("[search] 그래프 이웃 생략:", e);
      nb.clear();
    }
  }

  return NextResponse.json({
    q,
    // 3글자 미만이면 인덱스가 못 붙는다는 걸 호출자가 알 수 있게 한다
    indexed: usesTrigramIndex(q),
    total: results.length,
    /** 랭킹된 통합 결과 — 새 호출자는 이걸 쓴다 */
    results: results.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      snippet: r.snippet,
      projectName: r.projectName,
      updatedAt: r.updatedAt,
      href: r.kind === "decision" ? `/docs?cat=decisions` : `/p/${r.id}`,
      ...(nb.has(r.id) ? { neighbors: nb.get(r.id) } : {}),
    })),
    // 기존 화면(Search.tsx)이 docs/decisions 를 쓰고 있어 함께 낸다.
    // 한쪽만 바꾸면 배포 순서에 따라 검색이 빈 화면이 되므로 둘 다 유지한다.
    docs: results.filter((r) => r.kind !== "decision").map((r) => ({ id: r.id, title: r.title, snippet: r.snippet })),
    decisions: results.filter((r) => r.kind === "decision").map((r) => ({ id: r.id, title: r.title, snippet: r.snippet })),
  });
}
