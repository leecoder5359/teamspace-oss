import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { computeLint } from "@/lib/wikilink";

export const runtime = "nodejs";

// GET /api/lint → 위키 점검(깨진 링크 + 고아 문서)
export async function GET() {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const pages = await prisma.page.findMany({
    where: { workspaceId, kind: "doc", deletedAt: null },
    select: { id: true, title: true, markdown: true },
  });
  return NextResponse.json(computeLint(pages));
}
