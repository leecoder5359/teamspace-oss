import { describe, it, expect } from "vitest";
import { selectDueOnce, type DueSchedule } from "./dispatch";

const NOW = "2026-06-30T12:00:00.000Z";

function s(partial: Partial<DueSchedule> & { id: string }): DueSchedule {
  return { kind: "once", status: "active", spec: "2026-06-30T10:00:00.000Z", ...partial };
}

describe("selectDueOnce", () => {
  it("만기(과거)·once·active 만 고른다", () => {
    const due = selectDueOnce([s({ id: "a" })], NOW);
    expect(due.map((x) => x.id)).toEqual(["a"]);
  });

  it("정확히 같은 시각은 만기로 본다(<=)", () => {
    const due = selectDueOnce([s({ id: "eq", spec: NOW })], NOW);
    expect(due.map((x) => x.id)).toEqual(["eq"]);
  });

  it("미래 스케줄은 제외", () => {
    const due = selectDueOnce([s({ id: "future", spec: "2026-07-01T00:00:00.000Z" })], NOW);
    expect(due).toEqual([]);
  });

  it("active 아닌 상태(done/failed/paused)는 제외", () => {
    const items = [
      s({ id: "done", status: "done" }),
      s({ id: "failed", status: "failed" }),
      s({ id: "paused", status: "paused" }),
    ];
    expect(selectDueOnce(items, NOW)).toEqual([]);
  });

  it("once 가 아닌 kind(cron)는 제외", () => {
    expect(selectDueOnce([s({ id: "cron", kind: "cron" })], NOW)).toEqual([]);
  });

  it("잘못된 spec 은 제외, 잘못된 now 는 빈 배열", () => {
    expect(selectDueOnce([s({ id: "bad", spec: "not-a-date" })], NOW)).toEqual([]);
    expect(selectDueOnce([s({ id: "a" })], "nonsense")).toEqual([]);
  });
});

import { parseRecurringSpec, recurringDueAt } from "./dispatch";

describe("parseRecurringSpec (W7 반복 리마인더)", () => {
  it("daily:HH:MM", () => {
    expect(parseRecurringSpec("daily:09:30")).toEqual({ every: "daily", hour: 9, minute: 30 });
  });
  it("weekly:DDD:HH:MM", () => {
    expect(parseRecurringSpec("weekly:MON:10:00")).toEqual({ every: "weekly", weekday: 1, hour: 10, minute: 0 });
    const sun = parseRecurringSpec("weekly:SUN:00:05");
    expect(sun && sun.every === "weekly" ? sun.weekday : -1).toBe(0);
  });
  it("잘못된 포맷 → null", () => {
    expect(parseRecurringSpec("daily:25:00")).toBeNull();
    expect(parseRecurringSpec("weekly:XXX:09:00")).toBeNull();
    expect(parseRecurringSpec("2026-07-01T09:00:00Z")).toBeNull();
  });
});

describe("recurringDueAt", () => {
  // now 기준 가장 최근 발생 시각을 구하고, lastRunAt 이후면 due
  it("daily: 오늘 시각이 지났고 아직 안 보냈으면 due", () => {
    const due = recurringDueAt("daily:09:00", "2026-07-05T10:00:00+09:00", null);
    expect(due).not.toBeNull();
  });
  it("daily: 오늘 시각 전이면 due 아님(어제 발생분은 lastRunAt 이후일 때만)", () => {
    expect(recurringDueAt("daily:09:00", "2026-07-05T08:00:00+09:00", "2026-07-04T09:00:30+09:00")).toBeNull();
  });
  it("daily: 이미 오늘 보냈으면 due 아님", () => {
    expect(recurringDueAt("daily:09:00", "2026-07-05T10:00:00+09:00", "2026-07-05T09:00:30+09:00")).toBeNull();
  });
  it("weekly: 이번 주 해당 요일 시각 경과 + 미발송 → due", () => {
    // 2026-07-05 는 일요일
    expect(recurringDueAt("weekly:SUN:09:00", "2026-07-05T10:00:00+09:00", "2026-06-28T09:00:30+09:00")).not.toBeNull();
    expect(recurringDueAt("weekly:MON:09:00", "2026-07-05T10:00:00+09:00", "2026-06-29T09:00:30+09:00")).toBeNull();
  });
});
