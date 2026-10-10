import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { loadAccess, visibleOnly } from "@/lib/pageGuard";
import { tokenize, rankSources, buildExtractiveAnswer, type SourceDoc } from "@/lib/ask";
import { synthesizeAnswer } from "@/lib/llm";
import { loadArchivedPageIds, excludeArchived } from "@/lib/pageArchive";

export const runtime = "nodejs";

// GET /api/ask?q= → vault Q&A. 문서·결정 본문에서 근거를 찾아 답한다.
//   { question, answer, mode: "llm"|"extractive"|"empty", sources:[{id,title,kind,passage,heading}] }
export async function GET(request: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const question = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (!question) {
    return NextResponse.json({ question, answer: "질문을 입력해 주세요.", mode: "empty", sources: [] });
  }

  const terms = tokenize(question);
  if (terms.length === 0) {
    return NextResponse.json({ question, answer: "검색할 키워드가 없습니다.", mode: "empty", sources: [] });
  }

  // OR 조건으로 후보를 넓게 가져온 뒤(본문은 큰 비용이므로 take 제한), 순수 랭킹으로 좁힌다.
  const ors = terms.map((t) => ({ markdown: { contains: t, mode: "insensitive" as const } }));
  const titleOrs = terms.map((t) => ({ title: { contains: t, mode: "insensitive" as const } }));
  const [docs, decisions] = await Promise.all([
    prisma.page.findMany({
      where: { workspaceId, kind: "doc", deletedAt: null, OR: [...ors, ...titleOrs] },
      select: { id: true, title: true, markdown: true },
      take: 40,
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
      take: 40,
    }),
  ]);

  // D3: 답변 합성에 못 보는 문서가 섞이면 본문이 그대로 흘러나온다.
  // 보관 문서(조상 규칙)는 근거로 쓰지 않는다 — 옵트인 없음. 가시성 거른 다음에 뺀다.
  const idx = await loadAccess(guard);
  const archived = await loadArchivedPageIds(prisma, workspaceId);
  const candidates: SourceDoc[] = [
    ...excludeArchived(visibleOnly(idx, docs), archived).map((d) => ({ id: d.id, title: d.title, kind: "doc" as const, body: d.markdown ?? "" })),
    ...decisions.map((d) => ({
      id: d.id,
      title: d.title,
      kind: "decision" as const,
      body: [d.context, d.decision].filter(Boolean).join("\n\n"),
    })),
  ];

  const sources = rankSources(candidates, terms, 5);

  if (sources.length === 0) {
    return NextResponse.json({ question, answer: buildExtractiveAnswer(sources), mode: "empty", sources: [] });
  }

  // LLM 키가 있으면 합성, 실패/부재 시 추출형으로 폴백.
  const llm = await synthesizeAnswer(question, sources, { feature: "ask", workspaceId });
  const answer = llm ?? buildExtractiveAnswer(sources);
  return NextResponse.json({ question, answer, mode: llm ? "llm" : "extractive", sources });
}
