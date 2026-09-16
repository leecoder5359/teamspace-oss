import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { summarizeAccess } from "@/lib/sites/accessLog";

export const runtime = "nodejs";

/* GET /api/sites/[id]/access → { accounts: AccountAccess[], total } — 계정별 접근 이력.
   셸(/s/<slug>) 열람만 기록된다(같은 계정 10분 내 재열람 생략). 최근 180일·5000건까지만 읽는다. */

const WINDOW_DAYS = 180;
const MAX_ROWS = 5000;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx("viewer");
  if ("err" in ctx) return ctx.err;
  const { id } = await params;
  const site = await prisma.publishedSite.findFirst({
    where: { id, workspaceId: ctx.workspaceId, deletedAt: null },
    select: { id: true, invites: { select: { email: true } } },
  });
  if (!site) return NextResponse.json({ error: "사이트를 찾을 수 없습니다." }, { status: 404 });

  const rows = await prisma.siteAccess.findMany({
    where: { siteId: id, createdAt: { gte: new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000) } },
    orderBy: { createdAt: "desc" },
    take: MAX_ROWS,
    select: { email: true, member: true, version: true, createdAt: true },
  });
  const accounts = summarizeAccess(rows, site.invites.map((i) => i.email));
  return NextResponse.json({ accounts, total: rows.length, windowDays: WINDOW_DAYS });
}
