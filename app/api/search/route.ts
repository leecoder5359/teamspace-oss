import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { snippet } from "@/lib/search";

export const runtime = "nodejs";

// GET /api/search?q= → 문서·결정 본문 검색(대소문자 무시)
export async function GET(request: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (q.length < 1) return NextResponse.json({ docs: [], decisions: [] });

  const ci = { contains: q, mode: "insensitive" as const };

  const [docs, decisions] = await Promise.all([
    prisma.page.findMany({
      where: { workspaceId, kind: "doc", deletedAt: null, OR: [{ title: ci }, { markdown: ci }] },
      select: { id: true, title: true, markdown: true },
      take: 30,
    }),
    prisma.decision.findMany({
      where: { workspaceId, OR: [{ title: ci }, { context: ci }, { decision: ci }] },
      select: { id: true, title: true, context: true, decision: true },
      take: 30,
    }),
  ]);

  return NextResponse.json({
    docs: docs.map((d) => ({ id: d.id, title: d.title, snippet: snippet(d.markdown ?? "", q) })),
    decisions: decisions.map((d) => ({
      id: d.id,
      title: d.title,
      snippet: snippet([d.context, d.decision].filter(Boolean).join(" · ") || d.title, q),
    })),
  });
}
