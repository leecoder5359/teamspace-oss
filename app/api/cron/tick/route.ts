import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { dispatchDue, selectDueOnce } from "@/lib/dispatch";
import { notifyTasksDue } from "@/lib/notify";

export const runtime = "nodejs";

// GET /api/cron/tick → 만기 대기 건수 미리보기(부수효과 없음)
export async function GET() {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const active = await prisma.schedule.findMany({
    where: { kind: "once", status: "active" },
    select: { id: true, kind: true, spec: true, status: true },
  });
  const due = selectDueOnce(active, new Date().toISOString());
  return NextResponse.json({ active: active.length, due: due.length });
}

// POST /api/cron/tick → 만기 스케줄 1회 디스패치(외부 cron/워커가 호출)
export async function POST() {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const result = await dispatchDue();
  const due = await notifyTasksDue();
  return NextResponse.json({ ...result, taskDueNotified: due.notified });
}
