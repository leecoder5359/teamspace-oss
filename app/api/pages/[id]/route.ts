import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { requirePage } from "@/lib/pageGuard";
import { getPageContent, savePageContent, patchPageMeta, trashPage, type SavePageInput } from "@/lib/pageService";
import { failResponse } from "@/lib/serviceResult";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";

// fs を使うルートは nodejs ランタイム必須
export const runtime = "nodejs";

// 본체(본문 읽기/저장·메타 변경·휴지통)는 lib/pageService. 여기는 가드 → 본문 읽기 → 서비스 → 응답.
// 본문 읽기는 readBody — 깨진 JSON 은 400(종전엔 {} 로 삼켜 엉뚱한 400·200 이 났다).

// PUT 본문. baseRev 는 일부러 느슨하다 — 숫자가 아니면 검사를 건너뛰는 opt-in(lib/concurrency.checkBaseRev).
const PutBody = z.object({ markdown: z.string().optional(), title: z.string().nullish(), baseRev: z.unknown().optional() });

// GET /api/pages/[id] → ページメタ + 本文(markdown)
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  // D3: 볼 수 없는 페이지는 '없는' 것이다(404).
  const gate = await requirePage(guard, id, "view");
  if ("err" in gate) return gate.err;
  const result = await getPageContent(guard, id);
  if (!result.ok) return failResponse(result);
  return NextResponse.json({ page: result.page, markdown: result.markdown });
}

// PUT /api/pages/[id] → 本文保存 { markdown?, title?, baseRev? }
//   markdown 없으면 제목만 갱신(doc-1) · baseRev 불일치 409(doc-2/inv-8) · 저장마다 rev+1 + PageRevision(doc-3).
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const gate = await requirePage(guard, id, "edit");
  if ("err" in gate) return gate.err;
  const body = await readBody(req, PutBody);
  if (!body.ok) return body.res;
  const result = await savePageContent(guard, id, body.data as SavePageInput);
  if (!result.ok) return failResponse(result);
  return NextResponse.json(result);
}

// PATCH /api/pages/[id] → 페이지 메타 변경 { projectId?, title?, icon?, parentId?, docType? }
//   본문 검증(PatchBody)은 서비스가 404 판정 뒤에 한다 — 원래 응답 순서(404 → 400) 보존.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const gate = await requirePage(guard, id, "edit");
  if ("err" in gate) return gate.err;
  // 스키마(PatchBody) 검증은 서비스가 404 뒤에 한다 — 여기선 JSON 형식만.
  const body = await readBody(req, z.unknown());
  if (!body.ok) return body.res;
  const result = await patchPageMeta(guard, id, body.data);
  if (!result.ok) return failResponse(result);
  return NextResponse.json(result);
}

// DELETE /api/pages/[id] → 소프트 삭제(휴지통, inv-1). ?recursive=1 이면 서브트리 일괄(inv-23).
//   영구 삭제는 /api/trash/[id] DELETE.
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const gate = await requirePage(guard, id, "edit");
  if ("err" in gate) return gate.err;
  const recursive = new URL(req.url).searchParams.get("recursive") === "1";
  const result = await trashPage(guard, id, { recursive });
  if (!result.ok) return failResponse(result);
  return NextResponse.json(result);
}
