import { NextResponse } from "next/server";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { withIdempotency } from "@/lib/idempotency";
import { requireCtx } from "@/lib/workspace";
import { requirePage } from "@/lib/pageGuard";
import type { Ctx } from "@/lib/workspace";

export const runtime = "nodejs";

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

// GET /api/rows/[id]/comments → 댓글 목록(작성자 포함, 오래된→최신)
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const gate = await rowGate(guard, id, "view");
  if ("err" in gate) return gate.err;
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
  const { userId } = guard;
  const gate = await rowGate(guard, id, "edit");
  if ("err" in gate) return gate.err;

  // SKILL.md 는 'comments POST 는 Idempotency-Key 지원'이라고 열거하는데 이 라우트만
  // 빠져 있었다 — 문서 댓글(pages/[id]/comments)은 되고 행 댓글은 안 되는 걸 호출자가
  // 구분할 단서가 없었다(전수조사 D9).
  return withIdempotency(req, guard, async () => {
    const parsedBody = await readBody(req, z.object({ body: z.string().optional() }));
    if (!parsedBody.ok) return parsedBody.res;
    const body = parsedBody.data.body?.trim();
    if (!body) return NextResponse.json({ error: "댓글을 입력해 주세요." }, { status: 400 });
    const comment = await prisma.rowComment.create({
      data: { rowId: id, userId: userId ?? null, body },
      include: { user: { select: { id: true, name: true, image: true } } },
    });
    return NextResponse.json({ comment });
  });
}
