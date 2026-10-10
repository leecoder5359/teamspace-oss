import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { loadAccess, visibleOnly } from "@/lib/pageGuard";
import { loadGraph } from "@/lib/graphLoad";
import { neighbors as graphNeighbors } from "@/lib/graphInsights";
import { TASK_NOTE_EXCLUDE } from "@/lib/taskNotes";
import { queryVariants } from "@/lib/searchVariants";
import { passesFilters, rankSearch, usesTrigramIndex, type Candidate, type SearchKind } from "@/lib/searchRank";
import { archivedPageIds } from "@/lib/pageArchive";
import { withReq } from "@/lib/log";

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
/** 보관 id 가 이 수를 넘으면 notIn 대신 후보를 읽은 뒤 거른다. */
const ARCHIVED_NOTIN_CAP = 2000;
/** DB OR 에 싣는 변형 수 상한(원문 포함). queryVariants 는 랭킹용으로 최대 8개를 돌려주지만 쿼리는 이만큼만. */
const DB_VARIANTS = 5;

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
  const includeTaskNotes = sp.get("includeTaskNotes") === "1";
  const includeArchived = sp.get("archived") === "1";
  const limit = Math.min(100, Math.max(1, Number(sp.get("limit") ?? 30) || 30));
  const kinds = (sp.get("kind") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is SearchKind => s === "doc" || s === "board" || s === "decision");

  // 공백 변형("인증코어" ↔ "인증 코어")까지 OR 로 후보를 모은다. 순위는 rankSearch 가 원문 우선으로 매긴다.
  const variants = queryVariants(q);
  const ci = (v: string) => ({ contains: v, mode: "insensitive" as const });
  const wantPages = !kinds.length || kinds.includes("doc") || kinds.includes("board");
  const wantDecisions = !kinds.length || kinds.includes("decision");

  // 원문부터 조회하고, limit 에 못 미칠 때만 변형 OR 로 남은 몫을 채운다 — 변형 후보가
  // CANDIDATE_TAKE 를 채워 원문 일치를 밀어내는 일이 없게 한다. id 로 중복 제거.
  // 보관(F2): 조상이 보관된 하위 문서도 제외해야 하므로, 보관 페이지가 하나라도 있을 때만
  // 트리를 한 번 읽어 같은 집합을 만든다(대부분의 워크스페이스는 count 한 번으로 끝).
  let archivedIds: string[] = [];
  if (!includeArchived && (await prisma.page.count({ where: { workspaceId, deletedAt: null, archivedAt: { not: null } } })) > 0) {
    const tree = await prisma.page.findMany({ where: { workspaceId, deletedAt: null }, select: { id: true, parentId: true, archivedAt: true } });
    archivedIds = [...archivedPageIds(tree)];
  }
  // notIn 이 너무 길면 쿼리 파라미터 한도·계획 비용이 문제 — 상한을 넘으면 id 필터를 빼고 후보를 읽은 뒤 거른다.
  const archivedSet = new Set(archivedIds);
  const postFilterArchived = archivedIds.length > ARCHIVED_NOTIN_CAP;
  const pageWhere = (vs: string[]) => ({
    workspaceId, deletedAt: null, ...(archivedIds.length && !postFilterArchived ? { id: { notIn: archivedIds } } : {}), OR: vs.flatMap((v) => [{ title: ci(v) }, { markdown: ci(v) }]),
    // 태스크 설명은 기본 제외 — AND 로 묶어 위 OR 와 충돌하지 않게 한다.
    ...(includeTaskNotes ? {} : { AND: [TASK_NOTE_EXCLUDE] }),
  });
  const pageSelect = {
    id: true, title: true, markdown: true, kind: true, updatedAt: true,
    projectId: true, project: { select: { name: true } },
  } as const;
  const decisionWhere = (vs: string[]) => ({
    workspaceId, OR: vs.flatMap((v) => [{ title: ci(v) }, { context: ci(v) }, { decision: ci(v) }]),
  });
  const decisionSelect = { id: true, title: true, context: true, decision: true, projectId: true, createdAt: true } as const;
  const extra = variants.slice(1, DB_VARIANTS);

  // 변형 폴백 여부는 projectId·kind·기간 필터를 **통과한** 건수로 정한다. 필터 전 건수로 비교하면
  // 원문 후보가 limit 이상이어도 필터에 다 걸러져 변형 일치가 영영 조회되지 않는다.
  const filters = { projectId, kinds, from, to };
  async function fetchWithFallback<T extends { id: string }>(
    run: (vs: string[]) => Promise<T[]>,
    toCandidate: (r: T) => Candidate,
  ): Promise<T[]> {
    const first = await run([q]);
    const kept = first.filter((r) => passesFilters(toCandidate(r), filters)).length;
    if (kept >= limit || !extra.length) return first;
    const seen = new Set(first.map((r) => r.id));
    const more = await run(extra);
    return [...first, ...more.filter((r) => !seen.has(r.id))];
  }

  const [pages, decisions] = await Promise.all([
    wantPages
      ? fetchWithFallback(
          async (vs) => {
            const rows = await prisma.page.findMany({ where: pageWhere(vs), select: pageSelect, take: CANDIDATE_TAKE });
            return postFilterArchived ? rows.filter((r) => !archivedSet.has(r.id)) : rows;
          },
          (p) => ({ id: p.id, kind: (p.kind === "database" ? "board" : "doc") as SearchKind, title: p.title, body: "", projectId: p.projectId, projectName: null, updatedAt: p.updatedAt }),
        )
      : Promise.resolve([]),
    wantDecisions
      ? fetchWithFallback(
          (vs) => prisma.decision.findMany({ where: decisionWhere(vs), select: decisionSelect, take: CANDIDATE_TAKE }),
          (d) => ({ id: d.id, kind: "decision" as SearchKind, title: d.title, body: "", projectId: d.projectId, projectName: null, updatedAt: d.createdAt }),
        )
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

  const results = rankSearch(candidates, q, { projectId, kinds, from, to }, limit, Date.now(), variants);

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
      withReq(request).warn("search.neighbors_skipped", { msg: "그래프 로드 실패 — 이웃만 생략", err: e });
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
