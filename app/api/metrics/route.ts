import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { diffMetrics, snapshotWeek, stripCost, type MetricData } from "@/lib/metrics";

export const runtime = "nodejs";

const Query = z.object({ weeks: z.coerce.number().int().min(1).max(52).default(8) });

/**
 * GET /api/metrics?weeks=8 (editor 이상; 비용 llm.usd 는 admin 에게만) → { weeks:[{weekKey,data,createdAt}] (최신 주 먼저), diff:[{key,prev,cur,delta}] }.
 *   diff = 최근 2주 비교(스냅샷이 1개면 prev/delta 가 null, 0개면 빈 배열). weeks 1..52, 기본 8.
 * POST /api/metrics (admin) → 이번 ISO 주 스냅샷을 지금 1회 생성 { created, weekKey } (이미 있으면 created:false).
 */
export async function GET(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const parsed = Query.safeParse({ weeks: new URL(request.url).searchParams.get("weeks") ?? undefined });
  if (!parsed.success) return NextResponse.json({ error: "weeks 는 1~52 정수여야 합니다." }, { status: 400 });
  const rows = await prisma.metricSnapshot.findMany({
    where: { workspaceId: guard.workspaceId },
    orderBy: { weekKey: "desc" },
    take: parsed.data.weeks,
  });
  const weeks = rows.map((r) => ({ weekKey: r.weekKey, data: r.data as MetricData, createdAt: r.createdAt.toISOString() }));
  const diff = weeks[0] ? diffMetrics(weeks[1]?.data ?? null, weeks[0].data) : [];
  return NextResponse.json(stripCost({ weeks, diff }, guard.role === "admin"));
}

export async function POST() {
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  return NextResponse.json(await snapshotWeek(guard.workspaceId));
}
