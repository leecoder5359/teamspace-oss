import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { requirePage } from "@/lib/pageGuard";
import { complete } from "@/lib/llm";
import { buildDodPrompt, parseDodJson, diffDod } from "@/lib/extract";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";

const ExtractBody = z.object({
  pageId: z.string().optional(),
});

export const runtime = "nodejs";

// POST /api/dod/extract { pageId } → 문서에서 완료 기준을 추출해 기존 DoD 와 대조한 제안 반환.
//   { ok, sourcePageId, proposals:[{text,status(new|duplicate),existingId?}] }
//   자동 기록하지 않는다(검토 단계). 수락은 POST /api/dod { text }.
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
  const gate = await requirePage(guard, pageId, "view");
  if ("err" in gate) return gate.err;

  const page = await prisma.page.findFirst({
    where: { id: pageId, workspaceId, kind: "doc", deletedAt: null },
    select: { id: true, title: true, markdown: true },
  });
  if (!page) return NextResponse.json({ error: "문서를 찾을 수 없습니다." }, { status: 404 });

  const raw = await complete(buildDodPrompt(page.title, page.markdown ?? ""), { feature: "dod-extract", workspaceId });
  if (raw === null) {
    return NextResponse.json(
      { ok: false, error: "LLM 미설정/실패. ASK_LLM_PROVIDER(api|cli) 또는 키를 확인하세요.", proposals: [] },
      { status: 503 },
    );
  }

  const extracted = parseDodJson(raw);
  const existing = await prisma.dodItem.findMany({ where: { workspaceId }, select: { id: true, text: true } });
  const proposals = diffDod(extracted, existing);

  return NextResponse.json({ ok: true, sourcePageId: page.id, proposals });
}
