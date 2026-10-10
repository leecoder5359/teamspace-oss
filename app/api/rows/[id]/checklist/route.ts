import { NextResponse } from "next/server";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { requirePage } from "@/lib/pageGuard";
import type { Ctx } from "@/lib/workspace";

export const runtime = "nodejs";

// 행(태스크)이 현재 워크스페이스 소속인지 확인
/**
 * 행이 이 워크스페이스 것인지 + **그 행이 속한 보드에 접근할 수 있는지**(D3).
 * 워크스페이스 확인만 하던 것을 게이트까지 넓혔다 — 체크리스트·댓글은 태스크 내용
 * 그 자체라, 보드를 못 보는 사람에게 열려 있으면 보드를 잠근 의미가 없다.
 */
async function rowGate(guard: Ctx, rowId: string, min: "view" | "edit") {
  const row = await prisma.dbRow.findUnique({
    where: { id: rowId },
    select: { databasePageId: true, database: { select: { workspaceId: true } } },
  });
  if (!row || row.database.workspaceId !== guard.workspaceId) {
    return { err: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  return requirePage(guard, row.databasePageId, min);
}

// GET /api/rows/[id]/checklist → 체크리스트 항목 목록
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const gate = await rowGate(guard, id, "view");
  if ("err" in gate) return gate.err;
  const items = await prisma.rowChecklistItem.findMany({
    where: { rowId: id },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  return NextResponse.json({ items });
}

// POST /api/rows/[id]/checklist → 항목 추가 { text }
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const gate = await rowGate(guard, id, "view");
  if ("err" in gate) return gate.err;
  const parsedBody = await readBody(req, z.object({ text: z.string().optional() }));
  if (!parsedBody.ok) return parsedBody.res;
  const body = parsedBody.data;
  const text = body.text?.trim();
  if (!text) return NextResponse.json({ error: "내용을 입력해 주세요." }, { status: 400 });
  const last = await prisma.rowChecklistItem.findFirst({ where: { rowId: id }, orderBy: { position: "desc" }, select: { position: true } });
  const item = await prisma.rowChecklistItem.create({ data: { rowId: id, text, position: (last?.position ?? -1) + 1 } });
  return NextResponse.json({ item });
}
