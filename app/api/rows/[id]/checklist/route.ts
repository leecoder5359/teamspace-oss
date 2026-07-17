import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

// 행(태스크)이 현재 워크스페이스 소속인지 확인
async function rowInWorkspace(rowId: string, workspaceId: string): Promise<boolean> {
  const row = await prisma.dbRow.findUnique({
    where: { id: rowId },
    select: { database: { select: { workspaceId: true } } },
  });
  return !!row && row.database.workspaceId === workspaceId;
}

// GET /api/rows/[id]/checklist → 체크리스트 항목 목록
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  if (!(await rowInWorkspace(id, workspaceId))) return NextResponse.json({ error: "Not found" }, { status: 404 });
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
  const { workspaceId } = guard;
  if (!(await rowInWorkspace(id, workspaceId))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { text?: string };
  const text = body.text?.trim();
  if (!text) return NextResponse.json({ error: "내용을 입력해 주세요." }, { status: 400 });
  const last = await prisma.rowChecklistItem.findFirst({ where: { rowId: id }, orderBy: { position: "desc" }, select: { position: true } });
  const item = await prisma.rowChecklistItem.create({ data: { rowId: id, text, position: (last?.position ?? -1) + 1 } });
  return NextResponse.json({ item });
}
