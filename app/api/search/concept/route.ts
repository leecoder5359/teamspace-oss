import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { loadAccess, visibleOnly } from "@/lib/pageGuard";
import { tokenize, rankSources, type SourceDoc } from "@/lib/ask";
import { complete } from "@/lib/llm";
import { buildExpansionPrompt, parseExpansion, mergeTerms } from "@/lib/semsearch";
import { loadArchivedPageIds, excludeArchived } from "@/lib/pageArchive";

export const runtime = "nodejs";

// GET /api/search/concept?q= → LLM 질의 확장 기반 개념 검색.
//   { query, expanded:[...], terms:[...], mode("expanded"|"plain"), results:[{id,title,kind,passage,heading}] }
export async function GET(request: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const sp = new URL(request.url).searchParams;
  const query = (sp.get("q") ?? "").trim();
  const includeArchived = sp.get("archived") === "1";
  if (!query) return NextResponse.json({ query, expanded: [], terms: [], mode: "plain", results: [] });

  const base = tokenize(query);
  if (base.length === 0) return NextResponse.json({ query, expanded: [], terms: [], mode: "plain", results: [] });

  // LLM 확장(없으면 원 토큰만으로 graceful)
  const raw = await complete(buildExpansionPrompt(query), { feature: "search-concept", workspaceId });
  const expanded = raw ? parseExpansion(raw) : [];
  const terms = mergeTerms(base, expanded);

  const ors = terms.map((t) => ({ markdown: { contains: t, mode: "insensitive" as const } }));
  const titleOrs = terms.map((t) => ({ title: { contains: t, mode: "insensitive" as const } }));
  const [docs, decisions] = await Promise.all([
    prisma.page.findMany({
      where: { workspaceId, kind: "doc", deletedAt: null, OR: [...ors, ...titleOrs] },
      select: { id: true, title: true, markdown: true },
      take: 50,
    }),
    prisma.decision.findMany({
      where: {
        workspaceId,
        OR: terms.flatMap((t) => [
          { title: { contains: t, mode: "insensitive" as const } },
          { context: { contains: t, mode: "insensitive" as const } },
          { decision: { contains: t, mode: "insensitive" as const } },
        ]),
      },
      select: { id: true, title: true, context: true, decision: true },
      take: 50,
    }),
  ]);

  // D3: 답변 합성에 못 보는 문서가 섞이면 본문이 그대로 흘러나온다.
  // 보관 문서(조상 규칙)는 가시성 거른 다음에 뺀다(?archived=1 이면 포함).
  const idx = await loadAccess(guard);
  const archived = includeArchived ? new Set<string>() : await loadArchivedPageIds(prisma, workspaceId);
  const candidates: SourceDoc[] = [
    ...excludeArchived(visibleOnly(idx, docs), archived).map((d) => ({ id: d.id, title: d.title, kind: "doc" as const, body: d.markdown ?? "" })),
    ...decisions.map((d) => ({
      id: d.id,
      title: d.title,
      kind: "decision" as const,
      body: [d.context, d.decision].filter(Boolean).join("\n\n"),
    })),
  ];

  const results = rankSources(candidates, terms, 12);
  return NextResponse.json({ query, expanded, terms, mode: raw ? "expanded" : "plain", results });
}
