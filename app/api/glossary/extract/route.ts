import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { requirePage } from "@/lib/pageGuard";
import { complete } from "@/lib/llm";
import { buildGlossaryPrompt, parseGlossaryJson, diffGlossary } from "@/lib/extract";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";

const ExtractBody = z.object({
  pageId: z.string().optional(),
});

export const runtime = "nodejs";

// POST /api/glossary/extract { pageId } → 문서에서 용어를 추출해 기존 용어집과 대조한 제안 반환.
//   { ok, sourcePageId, proposals:[{term,definition,status(new|duplicate|conflict),existingId?,existingDefinition?}] }
//   자동 기록하지 않는다(검토 단계). 수락은 POST /api/glossary { term, definition, sourcePageId }.
export async function POST(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const parsed = await readBody(request, ExtractBody);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  const pageId = body.pageId?.trim();
  if (!pageId) return NextResponse.json({ error: "pageId가 필요합니다." }, { status: 400 });
  // D3: 못 보는 문서를 LLM 파이프라인에 넣어 요약·추출로 우회 열람할 수 없다.
  if (pageId) {
    const gate = await requirePage(guard, pageId, "view");
    if ("err" in gate) return gate.err;
  }

  const page = await prisma.page.findFirst({
    where: { id: pageId, workspaceId, kind: "doc", deletedAt: null },
    select: { id: true, title: true, markdown: true },
  });
  if (!page) return NextResponse.json({ error: "문서를 찾을 수 없습니다." }, { status: 404 });

  const raw = await complete(buildGlossaryPrompt(page.title, page.markdown ?? ""), { feature: "glossary-extract", workspaceId });
  if (raw === null) {
    return NextResponse.json(
      { ok: false, error: "LLM 미설정/실패. ASK_LLM_PROVIDER(api|cli) 또는 키를 확인하세요.", proposals: [] },
      { status: 503 },
    );
  }

  const extracted = parseGlossaryJson(raw);
  const existing = await prisma.glossaryTerm.findMany({
    where: { workspaceId },
    select: { id: true, term: true, definition: true },
  });
  const proposals = diffGlossary(extracted, existing);

  return NextResponse.json({ ok: true, sourcePageId: page.id, proposals });
}
