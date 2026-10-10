import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { withIdempotency } from "@/lib/idempotency";
import { createRecurring, createReminder, listReminders } from "@/lib/schedule";
import { parseRecurringSpec } from "@/lib/dispatch";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";

const ScheduleBody = z.object({
  remindAt: z.string().optional(),
  text: z.string().optional(),
  databasePageId: z.string().optional(),
  rowId: z.string().optional(),
  channelId: z.string().optional(),
  repeat: z.string().optional(),
  time: z.string().optional(),
});

// GET /api/schedules?databasePageId=... → 등록된 알림(once) 목록
export async function GET(request: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const url = new URL(request.url);
  const databasePageId = url.searchParams.get("databasePageId") ?? undefined;
  const schedules = await listReminders(workspaceId, databasePageId);
  return NextResponse.json({ schedules });
}

// POST /api/schedules → 간편 할일 알림 등록
export async function POST(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  return withIdempotency(request, guard, async () => {
  const parsed = await readBody(request, ScheduleBody);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  const text = body.text?.trim();
  // 반복 리마인더 (W7 inv-10): repeat+time → kind=cron, spec=daily:HH:MM | weekly:DDD:HH:MM
  if (body.repeat && text) {
    const time = body.time?.trim() ?? "";
    const rep = body.repeat.trim().toUpperCase();
    const spec = rep === "DAILY" ? `daily:${time}` : rep.startsWith("WEEKLY:") ? `weekly:${rep.slice(7)}:${time}` : "";
    if (!spec || !parseRecurringSpec(spec)) {
      return NextResponse.json({ error: 'repeat 은 "daily" 또는 "weekly:MON..SUN", time 은 "HH:MM" 이어야 합니다.' }, { status: 400 });
    }
    const schedule = await createRecurring(
      workspaceId,
      spec,
      { text, databasePageId: body.databasePageId, rowId: body.rowId },
      body.channelId?.trim() || undefined,
    );
    return NextResponse.json({ schedule });
  }
  const remindAt = body.remindAt?.trim();
  if (!remindAt || !text) {
    return NextResponse.json({ error: "remindAt and text are required" }, { status: 400 });
  }
  const when = new Date(remindAt);
  if (Number.isNaN(when.getTime())) {
    return NextResponse.json({ error: "Invalid remindAt" }, { status: 400 });
  }
  const schedule = await createReminder(
    workspaceId,
    when.toISOString(),
    { text, databasePageId: body.databasePageId, rowId: body.rowId },
    body.channelId?.trim() || undefined,
  );
  return NextResponse.json({ schedule });
  });
}
