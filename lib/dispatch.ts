import { prisma } from "@/lib/prisma";
import { postMessage } from "@/lib/slack";
import type { ReminderTemplate } from "@/lib/schedule";

/**
 * 예약 작업 디스패처.
 * 만기된 once 스케줄(예약 알림)을 스캔해 Slack 으로 발송하고 종료 상태로 마킹한다.
 * 워커 컨테이너(scripts/worker.ts)와 cron 트리거(/api/cron/tick)가 공유한다.
 *
 * 큐(BullMQ+redis) 대신 DB 폴링을 쓴다 — 단일 발송·낮은 빈도에 충분하고 검증이 쉽다.
 * 분산 재시도·지연 작업이 필요해지면 이 함수 뒤에 BullMQ 를 끼우면 된다.
 */

export type DueSchedule = {
  id: string;
  kind: string;
  spec: string; // ISO datetime(once) 또는 cron
  status: string;
};

/** 순수 함수: 주어진 시각 기준으로 발송 대상(만기 once·active)을 고른다. */
export function selectDueOnce<T extends DueSchedule>(schedules: T[], nowISO: string): T[] {
  const now = new Date(nowISO).getTime();
  if (Number.isNaN(now)) return [];
  return schedules.filter((s) => {
    if (s.kind !== "once" || s.status !== "active") return false;
    const at = new Date(s.spec).getTime();
    return !Number.isNaN(at) && at <= now;
  });
}


/* ── 반복 스케줄 (W7 inv-10) ──
   spec 포맷: "daily:HH:MM" · "weekly:DDD:HH:MM" (DDD=SUN..SAT, 로컬 시간대 기준). */

const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

export type RecurringSpec = { every: "daily"; hour: number; minute: number } | { every: "weekly"; weekday: number; hour: number; minute: number };

export function parseRecurringSpec(spec: string): RecurringSpec | null {
  const daily = /^daily:(\d{2}):(\d{2})$/.exec(spec);
  if (daily) {
    const hour = Number(daily[1]);
    const minute = Number(daily[2]);
    if (hour > 23 || minute > 59) return null;
    return { every: "daily", hour, minute };
  }
  const weekly = /^weekly:([A-Z]{3}):(\d{2}):(\d{2})$/.exec(spec);
  if (weekly) {
    const weekday = WEEKDAYS.indexOf(weekly[1] as (typeof WEEKDAYS)[number]);
    const hour = Number(weekly[2]);
    const minute = Number(weekly[3]);
    if (weekday < 0 || hour > 23 || minute > 59) return null;
    return { every: "weekly", weekday, hour, minute };
  }
  return null;
}

/**
 * 순수 함수: now 기준 "가장 최근 발생 시각"이 lastRunAt 이후이면 그 시각을 반환(=발송 due), 아니면 null.
 * 발생 시각 계산은 로컬 시간대. 반복 스케줄은 발송 후에도 active 를 유지하고 lastRunAt 만 갱신한다.
 */
export function recurringDueAt(spec: string, nowISO: string, lastRunAtISO: string | null): Date | null {
  const parsed = parseRecurringSpec(spec);
  if (!parsed) return null;
  const now = new Date(nowISO);
  if (Number.isNaN(now.getTime())) return null;

  const occ = new Date(now);
  occ.setHours(parsed.hour, parsed.minute, 0, 0);
  if (parsed.every === "weekly") {
    const diff = (now.getDay() - parsed.weekday + 7) % 7;
    occ.setDate(occ.getDate() - diff);
    if (diff === 0 && occ > now) occ.setDate(occ.getDate() - 7); // 오늘이 해당 요일인데 시각 전 → 지난주 발생분
  } else if (occ > now) {
    occ.setDate(occ.getDate() - 1); // 오늘 시각 전 → 어제 발생분
  }

  const last = lastRunAtISO ? new Date(lastRunAtISO).getTime() : 0;
  if (occ.getTime() <= last) return null;
  return occ;
}

export type DispatchResult = {
  checked: number;
  sent: number;
  failed: number;
  ids: string[];
};

/**
 * 만기 스케줄을 1회 디스패치한다(워크스페이스 전역).
 * @param nowISO 기준 시각(미지정 시 현재) — 테스트/재현용 주입 가능.
 */
export async function dispatchDue(nowISO?: string): Promise<DispatchResult> {
  const stamp = nowISO ?? new Date().toISOString();
  const active = await prisma.schedule.findMany({
    where: { kind: "once", status: "active" },
    orderBy: { spec: "asc" },
  });
  // 반복 스케줄 (W7): 발송 후에도 active 유지, lastRunAt 만 갱신
  const recurring = await prisma.schedule.findMany({ where: { kind: "cron", status: "active" } });
  const due = selectDueOnce(
    active.map((s) => ({ id: s.id, kind: s.kind, spec: s.spec, status: s.status })),
    stamp,
  );

  let sent = 0;
  let failed = 0;
  const ids: string[] = [];

  for (const d of due) {
    const sched = active.find((s) => s.id === d.id);
    if (!sched) continue;
    const tpl = (sched.template ?? {}) as ReminderTemplate;
    const text = tpl.text?.trim() || "(예약 알림)";

    let ok = false;
    try {
      const res = await postMessage(sched.workspaceId, {
        channel: sched.channelId || undefined,
        text: `⏰ ${text}`,
        kind: "reminder",
      });
      ok = res.ok;
    } catch {
      ok = false;
    }

    await prisma.schedule.update({
      where: { id: sched.id },
      data: { status: ok ? "done" : "failed", lastRunAt: new Date(stamp) },
    });
    ids.push(sched.id);
    if (ok) sent++;
    else failed++;
  }

  for (const sched of recurring) {
    const dueAt = recurringDueAt(sched.spec, stamp, sched.lastRunAt ? sched.lastRunAt.toISOString() : null);
    if (!dueAt) continue;
    const tpl = (sched.template ?? {}) as ReminderTemplate;
    const text = tpl.text?.trim() || "(반복 알림)";
    let ok = false;
    try {
      const res = await postMessage(sched.workspaceId, {
        channel: sched.channelId || undefined,
        text: `🔁 ${text}`,
        kind: "reminder",
      });
      ok = res.ok;
    } catch {
      ok = false;
    }
    await prisma.schedule.update({ where: { id: sched.id }, data: { lastRunAt: new Date(stamp) } });
    ids.push(sched.id);
    if (ok) sent++;
    else failed++;
  }

  return { checked: active.length + recurring.length, sent, failed, ids };
}
