import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { requirePage } from "@/lib/pageGuard";
import { resolveProjectRef } from "@/lib/projectRef";
import { complete } from "@/lib/llm";
import { buildQaPrompt, parseQaJson, diffQa } from "@/lib/extract";

export const runtime = "nodejs";

// POST /api/qa/extract { pageId, projectId? } → 문서에서 QA 시나리오를 추출해 기존 시나리오와 대조한 제안 반환.
//   { ok, sourcePageId, proposals:[{title,steps,expected,status(new|duplicate|conflict),existingId?,existingSteps?,existingExpected?}] }
//   projectId 를 주면 그 프로젝트의 시나리오하고만 대조한다(같은 제목이 프로젝트마다 있을 수 있어서).
//   자동 기록하지 않는다(검토 단계). 수락은 POST /api/qa { title, steps, expected, projectId }.
export async function POST(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const body = (await request.json().catch(() => ({}))) as { pageId?: string; projectId?: string };
  const pageId = body.pageId?.trim();
  if (!pageId) return NextResponse.json({ error: "pageId가 필요합니다." }, { status: 400 });
  // D3: 못 보는 문서를 LLM 파이프라인에 넣어 요약·추출로 우회 열람할 수 없다.
  const gate = await requirePage(guard, pageId, "view");
  if ("err" in gate) return gate.err;
  // 없는/남의 프로젝트는 조용히 무시하지 않고 400 으로 알린다(D5)
  const ref = await resolveProjectRef(body.projectId, workspaceId);
  if (!ref.ok) return ref.err;

  const page = await prisma.page.findFirst({
    where: { id: pageId, workspaceId, kind: "doc", deletedAt: null },
    select: { id: true, title: true, markdown: true },
  });
  if (!page) return NextResponse.json({ error: "문서를 찾을 수 없습니다." }, { status: 404 });

  const raw = await complete(buildQaPrompt(page.title, page.markdown ?? ""));
  if (raw === null) {
    return NextResponse.json(
      { ok: false, error: "LLM 미설정/실패. ASK_LLM_PROVIDER(api|cli) 또는 키를 확인하세요.", proposals: [] },
      { status: 503 },
    );
  }

  const extracted = parseQaJson(raw);
  const existing = await prisma.qaScenario.findMany({
    where: { workspaceId, ...(ref.projectId ? { projectId: ref.projectId } : {}) },
    select: { id: true, title: true, steps: true, expected: true },
  });
  const proposals = diffQa(extracted, existing);

  return NextResponse.json({ ok: true, sourcePageId: page.id, proposals });
}
