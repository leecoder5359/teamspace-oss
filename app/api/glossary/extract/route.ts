import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { complete } from "@/lib/llm";
import { buildGlossaryPrompt, parseGlossaryJson, diffGlossary } from "@/lib/extract";

export const runtime = "nodejs";

// POST /api/glossary/extract { pageId } → 문서에서 용어를 추출해 기존 용어집과 대조한 제안 반환.
//   { ok, sourcePageId, proposals:[{term,definition,status(new|duplicate|conflict),existingId?,existingDefinition?}] }
//   자동 기록하지 않는다(검토 단계). 수락은 POST /api/glossary { term, definition, sourcePageId }.
export async function POST(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const body = (await request.json().catch(() => ({}))) as { pageId?: string };
  const pageId = body.pageId?.trim();
  if (!pageId) return NextResponse.json({ error: "pageId가 필요합니다." }, { status: 400 });

  const page = await prisma.page.findFirst({
    where: { id: pageId, workspaceId, kind: "doc", deletedAt: null },
    select: { id: true, title: true, markdown: true },
  });
  if (!page) return NextResponse.json({ error: "문서를 찾을 수 없습니다." }, { status: 404 });

  const raw = await complete(buildGlossaryPrompt(page.title, page.markdown ?? ""));
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
