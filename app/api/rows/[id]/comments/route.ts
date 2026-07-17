import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

async function rowInWorkspace(rowId: string, workspaceId: string): Promise<boolean> {
  const row = await prisma.dbRow.findUnique({
    where: { id: rowId },
    select: { database: { select: { workspaceId: true } } },
  });
  return !!row && row.database.workspaceId === workspaceId;
}

// GET /api/rows/[id]/comments → 댓글 목록(작성자 포함, 오래된→최신)
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  if (!(await rowInWorkspace(id, workspaceId))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const comments = await prisma.rowComment.findMany({
    where: { rowId: id },
    orderBy: { createdAt: "asc" },
    include: { user: { select: { id: true, name: true, image: true } } },
  });
  return NextResponse.json({ comments });
}

// POST /api/rows/[id]/comments → 댓글 작성 { body } (작성자 = 현재 사용자)
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId, userId } = guard;
  if (!(await rowInWorkspace(id, workspaceId))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const b = (await req.json().catch(() => ({}))) as { body?: string };
  const body = b.body?.trim();
  if (!body) return NextResponse.json({ error: "댓글을 입력해 주세요." }, { status: 400 });
  const comment = await prisma.rowComment.create({
    data: { rowId: id, userId: userId ?? null, body },
    include: { user: { select: { id: true, name: true, image: true } } },
  });
  return NextResponse.json({ comment });
}
