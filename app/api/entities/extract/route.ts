import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { complete } from "@/lib/llm";
import { buildEntityPrompt, parseEntitiesJson, diffEntities } from "@/lib/extract";

export const runtime = "nodejs";

// POST /api/entities/extract { pageId } → 문서에서 엔티티 추출 후 기존 데이터모델과 대조한 제안 반환.
//   { ok, sourcePageId, proposals:[{name,description,fields,status,existingId?,existingDescription?}] } (자동기록 안 함)
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

  const raw = await complete(buildEntityPrompt(page.title, page.markdown ?? ""));
  if (raw === null) {
    return NextResponse.json(
      { ok: false, error: "LLM 미설정/실패. ASK_LLM_PROVIDER(api|cli) 또는 키를 확인하세요.", proposals: [] },
      { status: 503 },
    );
  }

  const extracted = parseEntitiesJson(raw);
  const existing = await prisma.entity.findMany({
    where: { workspaceId },
    select: { id: true, name: true, description: true, fields: true },
  });
  const proposals = diffEntities(extracted, existing);

  return NextResponse.json({ ok: true, sourcePageId: page.id, proposals });
}
