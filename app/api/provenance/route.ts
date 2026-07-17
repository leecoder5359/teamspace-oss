import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { complete } from "@/lib/llm";
import { buildProvenancePrompt, parseProvenance, countTags } from "@/lib/provenance";

export const runtime = "nodejs";

// POST /api/provenance { pageId } → 문서의 주장을 추출/추론/모호로 분류.
//   { ok, claims:[{claim,tag,note}], counts:{추출,추론,모호} }
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

  const raw = await complete(buildProvenancePrompt(page.title, page.markdown ?? ""));
  if (raw === null) {
    return NextResponse.json(
      { ok: false, error: "LLM 미설정/실패. ASK_LLM_PROVIDER(api|cli) 또는 키를 확인하세요.", claims: [] },
      { status: 503 },
    );
  }

  const claims = parseProvenance(raw);
  return NextResponse.json({ ok: true, claims, counts: countTags(claims) });
}
