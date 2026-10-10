import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { dayKey } from "@/lib/aiRoutes/relay";
import { getTeamspaceUsage } from "@/lib/aiRoutes/llmCalls";
import { dailyBudgetTokens, usedTokensToday } from "@/lib/llmBudget";
import { collectOpsStatus, evaluateOps, realDeps } from "@/lib/opsStatus";

export const runtime = "nodejs";

/**
 * GET /api/ops/status → 운영 상태(health·백업·디스크·오늘 AI 비용·빌드) + 경고 목록. 관리자 전용.
 * 백업·데이터 경로가 드러나므로 /api/health 와 달리 인증이 필요하다.
 */
export async function GET() {
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;

  const status = await collectOpsStatus(
    realDeps({
      heartbeat: async () => {
        try {
          await prisma.$queryRaw`SELECT 1`;
          const hb = await prisma.heartbeat.findUnique({ where: { id: "worker" } });
          return { db: true, at: hb?.at ?? null };
        } catch {
          return { db: false, at: null };
        }
      },
      usedTokensToday: () => usedTokensToday(),
      dailyBudgetTokens: () => dailyBudgetTokens(),
      usageByDay: async () => (await getTeamspaceUsage(guard.workspaceId, 1, { purge: false })).byDay,
      dayKey,
    }),
  );
  return NextResponse.json({ status, warnings: evaluateOps(status) }, { headers: { "Cache-Control": "no-store" } });
}
