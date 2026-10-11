import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCtx } from "@/lib/workspace";
import { readBody } from "@/lib/apiBody";
import { hygieneEnabled, listHygieneRuns, runWeeklyHygiene } from "@/lib/lessonHygiene/service";
import { log } from "@/lib/log";

export const runtime = "nodejs";

/**
 * GET /api/lessons/hygiene?limit=20 → { runs:[{id,weekKey,status,summary,counts,approvalId,appliedAt,revertedAt,createdAt}], enabled }
 *   레슨 주간 정리 실행 목록(편집자 이상). 개인 레슨은 정리 대상이 아니라 목록에도 없다.
 */
export async function GET(req: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const raw = Number(new URL(req.url).searchParams.get("limit") ?? 20);
  const limit = Number.isFinite(raw) ? Math.trunc(raw) : 20;
  return NextResponse.json({ runs: await listHygieneRuns(guard.workspaceId, limit), enabled: hygieneEnabled() });
}

const PostBody = z.object({ dryRun: z.boolean().optional() });

/**
 * POST /api/lessons/hygiene { dryRun? } (admin) → 지금 바로 이번 주 정리를 돌린다(워커 시간 창 무시).
 *   dryRun:true  → { dryRun:true, weekKey, proposal, signals, summary } — 저장·카드 없음(LLM 은 호출).
 *   dryRun 없음  → { dryRun:false, created, weekKey, run, sent?, error? } — 이번 주(weekKey) 실행이 이미 있으면 그대로 돌려준다(created:false).
 */
export async function POST(req: Request) {
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  const parsed = await readBody(req, PostBody);
  if (!parsed.ok) return parsed.res;
  try {
    const r = await runWeeklyHygiene(guard.workspaceId, { dryRun: !!parsed.data.dryRun, createdBy: guard.userId });
    return NextResponse.json(r);
  } catch (e) {
    log.warn("lesson_hygiene.run_now_failed", { msg: "레슨 주간 정리 실행 실패", workspaceId: guard.workspaceId, err: e });
    return NextResponse.json({ error: "레슨 주간 정리를 실행하지 못했습니다." }, { status: 500 });
  }
}
