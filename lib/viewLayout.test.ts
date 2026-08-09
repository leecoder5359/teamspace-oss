import { describe, it, expect } from "vitest";
import {
  monthGrid,
  addMonths,
  toDateKey,
  bucketByDay,
  spanOf,
  boundsOf,
  barMetrics,
  monthLabel,
} from "@/lib/viewLayout";

describe("monthGrid — 달력 격자", () => {
  it("2026년 8월: 1일이 토요일이라 앞이 6칸 비고 6월… 아니 7월로 채워진다", () => {
    const weeks = monthGrid(2026, 8);
    expect(weeks[0][0].date).toBe("2026-07-26"); // 그 주 일요일
    expect(weeks[0][0].inMonth).toBe(false);
    expect(weeks[0][6].date).toBe("2026-08-01");
    expect(weeks[0][6].inMonth).toBe(true);
  });

  it("모든 주는 7칸이고 날짜가 하루씩 이어진다", () => {
    for (const [y, m] of [
      [2026, 2],
      [2026, 8],
      [2024, 2], // 윤년
      [2025, 12],
    ] as const) {
      const weeks = monthGrid(y, m);
      const flat = weeks.flat();
      expect(flat.length % 7).toBe(0);
      for (const w of weeks) expect(w).toHaveLength(7);
      for (let i = 1; i < flat.length; i++) {
        const prev = new Date(`${flat[i - 1].date}T00:00:00Z`).getTime();
        const cur = new Date(`${flat[i].date}T00:00:00Z`).getTime();
        expect(cur - prev).toBe(86400000);
      }
    }
  });

  it("그 달의 모든 날이 정확히 한 번씩 들어 있다", () => {
    const inMonth = monthGrid(2024, 2).flat().filter((c) => c.inMonth);
    expect(inMonth).toHaveLength(29); // 2024는 윤년
    expect(inMonth[0].date).toBe("2024-02-01");
    expect(inMonth[28].date).toBe("2024-02-29");
  });

  it("빈 뒷줄을 만들지 않는다(필요한 주 수만)", () => {
    // 2026-02: 1일이 일요일, 28일 → 정확히 4주
    const weeks = monthGrid(2026, 2);
    expect(weeks).toHaveLength(4);
    expect(weeks[0][0].date).toBe("2026-02-01");
    expect(weeks[3][6].date).toBe("2026-02-28");
  });

  it("주 시작을 월요일로 바꿀 수 있다", () => {
    const weeks = monthGrid(2026, 8, 1);
    expect(weeks[0][0].date).toBe("2026-07-27"); // 월요일
    expect(weeks[0][5].date).toBe("2026-08-01");
  });

  it("오늘 표시는 호출자가 넘긴 기준일로만 정해진다(테스트 가능하도록)", () => {
    const weeks = monthGrid(2026, 8, 0, "2026-08-09");
    const today = weeks.flat().filter((c) => c.isToday);
    expect(today).toHaveLength(1);
    expect(today[0].date).toBe("2026-08-09");
  });
});

describe("addMonths", () => {
  it("연말·연초를 넘는다", () => {
    expect(addMonths(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(addMonths(2026, 8, 5)).toEqual({ year: 2027, month: 1 });
    expect(addMonths(2026, 3, -14)).toEqual({ year: 2025, month: 1 });
  });
});

describe("monthLabel", () => {
  it("한국어 표기", () => {
    expect(monthLabel(2026, 8)).toBe("2026년 8월");
  });
});

describe("toDateKey — 속성 값을 날짜 키로", () => {
  it("YYYY-MM-DD 는 그대로", () => {
    expect(toDateKey("2026-08-09")).toBe("2026-08-09");
  });

  it("ISO 타임스탬프는 날짜 부분만 — 시간대 변환을 하지 않는다", () => {
    // 저장된 값을 그대로 읽는다. UTC 로 바꾸면 한국 사용자가 입력한 날짜가
    // 하루 밀리는 고전적 사고가 난다.
    expect(toDateKey("2026-08-09T23:30:00.000Z")).toBe("2026-08-09");
    expect(toDateKey("2026-08-09T09:00")).toBe("2026-08-09");
  });

  it("날짜가 아니면 null", () => {
    for (const v of ["", null, undefined, "내일", 42, {}, "2026-13-01", "2026-02-30"]) {
      expect(toDateKey(v)).toBeNull();
    }
  });
});

describe("bucketByDay", () => {
  it("같은 날짜끼리 모으고 날짜 없는 항목은 버린다", () => {
    const rows = [
      { id: "a", d: "2026-08-09" },
      { id: "b", d: "2026-08-09T10:00:00Z" },
      { id: "c", d: "2026-08-10" },
      { id: "d", d: null },
    ];
    const m = bucketByDay(rows, (r) => r.d);
    expect(m.get("2026-08-09")!.map((r) => r.id)).toEqual(["a", "b"]);
    expect(m.get("2026-08-10")!.map((r) => r.id)).toEqual(["c"]);
    expect(m.has("")).toBe(false);
    expect([...m.keys()]).toHaveLength(2);
  });
});

describe("spanOf / boundsOf / barMetrics — 타임라인", () => {
  it("시작·종료가 다 있으면 그대로", () => {
    expect(spanOf("2026-08-01", "2026-08-05")).toEqual({ start: "2026-08-01", end: "2026-08-05" });
  });

  it("종료가 없으면 하루짜리로 본다", () => {
    expect(spanOf("2026-08-01", null)).toEqual({ start: "2026-08-01", end: "2026-08-01" });
  });

  it("시작이 없으면 막대를 그리지 않는다", () => {
    expect(spanOf(null, "2026-08-05")).toBeNull();
  });

  it("거꾸로 뒤집힌 기간은 바로잡는다(입력 실수)", () => {
    expect(spanOf("2026-08-09", "2026-08-01")).toEqual({ start: "2026-08-01", end: "2026-08-09" });
  });

  it("전체 범위는 최소·최대", () => {
    expect(
      boundsOf([
        { start: "2026-08-05", end: "2026-08-06" },
        { start: "2026-08-01", end: "2026-08-03" },
        { start: "2026-08-04", end: "2026-08-20" },
      ]),
    ).toEqual({ min: "2026-08-01", max: "2026-08-20" });
  });

  it("막대가 없으면 범위도 없다", () => {
    expect(boundsOf([])).toBeNull();
  });

  it("막대 위치는 백분율이고, 하루짜리도 폭이 남는다", () => {
    const bounds = { min: "2026-08-01", max: "2026-08-11" }; // 11일 구간
    const full = barMetrics({ start: "2026-08-01", end: "2026-08-11" }, bounds);
    expect(full.leftPct).toBe(0);
    expect(full.widthPct).toBe(100);

    const oneDay = barMetrics({ start: "2026-08-01", end: "2026-08-01" }, bounds);
    expect(oneDay.leftPct).toBe(0);
    expect(oneDay.widthPct).toBeCloseTo(100 / 11, 5);

    const mid = barMetrics({ start: "2026-08-06", end: "2026-08-06" }, bounds);
    expect(mid.leftPct).toBeCloseTo((5 / 11) * 100, 5);
  });

  it("범위가 하루뿐이어도 0 으로 나누지 않는다", () => {
    const b = barMetrics({ start: "2026-08-01", end: "2026-08-01" }, { min: "2026-08-01", max: "2026-08-01" });
    expect(b.leftPct).toBe(0);
    expect(b.widthPct).toBe(100);
  });

  it("범위 밖 막대는 잘라 넣는다(음수·초과 없음)", () => {
    const bounds = { min: "2026-08-05", max: "2026-08-10" };
    const before = barMetrics({ start: "2026-08-01", end: "2026-08-06" }, bounds);
    expect(before.leftPct).toBe(0);
    expect(before.widthPct).toBeGreaterThan(0);
    const after = barMetrics({ start: "2026-08-09", end: "2026-08-30" }, bounds);
    expect(after.leftPct + after.widthPct).toBeLessThanOrEqual(100.0001);
  });
});
