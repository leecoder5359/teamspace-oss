import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { requirePage } from "@/lib/pageGuard";
import { buildDashboardStats } from "@/lib/dashboardStats";

export const runtime = "nodejs";

// GET /api/databases/[id]/stats → { page:{id,title}, stats } — 대시보드 통계(lib/dashboardStats, 감사 P-8).
// 보드 전체(/api/databases/[id], 행 원본 수백 KB) 대신 숫자와 열린 마감 목록만 보낸다.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  // D3: 보드도 페이지다 — 같은 게이트를 통과해야 한다.
  const gate = await requirePage(guard, id, "view");
  if ("err" in gate) return gate.err;

  const page = await prisma.page.findFirst({
    where: { id, workspaceId: guard.workspaceId, kind: "database", deletedAt: null },
    select: { id: true, title: true },
  });
  if (!page) return NextResponse.json({ error: "Not a database" }, { status: 404 });

  const [properties, rows] = await Promise.all([
    prisma.dbProperty.findMany({ where: { databasePageId: id }, orderBy: { position: "asc" }, select: { id: true, name: true, type: true, config: true } }),
    prisma.dbRow.findMany({ where: { databasePageId: id }, orderBy: { position: "asc" }, select: { id: true, props: true } }),
  ]);
  return NextResponse.json({ page, stats: buildDashboardStats(properties, rows) });
}
