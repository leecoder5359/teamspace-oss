import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { dispatchDue, selectDueOnce } from "@/lib/dispatch";
import { notifyTasksDue } from "@/lib/notify";

export const runtime = "nodejs";

/* ⚠️ 이 라우트는 **워크스페이스 스코프가 아니다** — 전 워크스페이스의 스케줄을 본다.
   그게 의도다(scripts/worker.ts 가 dispatchDue() 를 인프로세스로 전역 실행하고,
   이 HTTP 경로는 그 수동 트리거다). 문제는 종전에 editor 면 통과시켜서, 한 워크스페이스의
   editor 토큰이 **다른 워크스페이스의 리마인더까지 발송·변경**할 수 있었다는 점이다
   (전수조사 D15). 전역 부수효과이므로 admin 을 요구하고, 응답에도 전역임을 밝힌다. */

// GET /api/cron/tick → 만기 대기 건수 미리보기(부수효과 없음, 전 워크스페이스 집계)
export async function GET() {
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  const active = await prisma.schedule.findMany({
    where: { kind: "once", status: "active" },
    select: { id: true, kind: true, spec: true, status: true },
  });
  const due = selectDueOnce(active, new Date().toISOString());
  return NextResponse.json({ active: active.length, due: due.length, scope: "all-workspaces" });
}

// POST /api/cron/tick → 만기 스케줄 1회 디스패치(외부 cron/워커가 호출)
export async function POST() {
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  const result = await dispatchDue();
  const due = await notifyTasksDue();
  return NextResponse.json({ ...result, taskDueNotified: due.notified, scope: "all-workspaces" });
}
