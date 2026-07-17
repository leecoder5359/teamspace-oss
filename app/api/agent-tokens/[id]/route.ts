import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

// DELETE /api/agent-tokens/[id] → 토큰 회수(revoke).
// 행은 남겨 발급·사용 이력을 보존하고, 에이전트 멤버십은 removed 로 전환한다.
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;

  const token = await prisma.agentToken.findUnique({ where: { id } });
  if (!token || token.workspaceId !== guard.workspaceId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (token.revokedAt) {
    return NextResponse.json({ error: "이미 회수된 토큰입니다." }, { status: 409 });
  }

  await prisma.$transaction([
    prisma.agentToken.update({ where: { id }, data: { revokedAt: new Date() } }),
    prisma.workspaceMember.updateMany({
      where: { workspaceId: guard.workspaceId, userId: token.userId },
      data: { status: "removed" },
    }),
  ]);
  return NextResponse.json({ ok: true });
}
