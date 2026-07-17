import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

export const runtime = "nodejs";

// GET /api/sessions/[id] → 세션 + 아이템(관찰·요약·결정·커밋·파일변경) 타임라인
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const session = await prisma.claudeSession.findFirst({
    where: { id, workspaceId },
    select: {
      id: true,
      externalId: true,
      project: true,
      cwd: true,
      status: true,
      startedAt: true,
      endedAt: true,
      items: {
        orderBy: { createdAt: "asc" },
        select: { id: true, kind: true, body: true, externalRef: true, createdAt: true },
      },
    },
  });
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ session });
}
