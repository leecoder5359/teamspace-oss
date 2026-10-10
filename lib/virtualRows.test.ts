import { describe, it, expect } from "vitest";
import { windowRange, windowSegments, virtualDisabled, VIRTUAL_THRESHOLD, DEFAULT_ROW_HEIGHT } from "./virtualRows";

const base = { scrollTop: 0, viewportHeight: 400, offsetTop: 0, rowHeight: 40, total: 1000 };

describe("windowRange", () => {
  it("상수는 계획값 그대로", () => {
    expect(VIRTUAL_THRESHOLD).toBe(150);
    expect(DEFAULT_ROW_HEIGHT).toBe(40);
  });

  it("맨 위: 보이는 10행 + 아래 overscan 10, 위 패딩 0", () => {
    const r = windowRange(base);
    expect(r).toEqual({ start: 0, end: 20, topPad: 0, bottomPad: (1000 - 20) * 40 });
  });

  it("중간: 위아래로 overscan 만큼 넓힌다", () => {
    // 4000px 스크롤 → 100번째 행부터 10행이 보인다
    const r = windowRange({ ...base, scrollTop: 4000 });
    expect(r.start).toBe(90);
    expect(r.end).toBe(120);
    expect(r.topPad).toBe(90 * 40);
    expect(r.bottomPad).toBe((1000 - 120) * 40);
  });

  it("부분적으로 걸친 행도 포함한다", () => {
    const r = windowRange({ ...base, scrollTop: 4020, overscan: 0 });
    expect(r.start).toBe(100);
    expect(r.end).toBe(111); // 100.5 ~ 110.5 → 100..110
  });

  it("offsetTop 만큼 표가 아래에서 시작하면 그만큼 덜 내려간 것으로 본다", () => {
    const r = windowRange({ ...base, scrollTop: 4200, offsetTop: 200, overscan: 0 });
    expect(r.start).toBe(100);
    expect(r.end).toBe(110);
  });

  it("표가 아직 화면 아래에 있으면 앞쪽 overscan 만", () => {
    const r = windowRange({ ...base, offsetTop: 2000 });
    expect(r).toEqual({ start: 0, end: 10, topPad: 0, bottomPad: 990 * 40 });
  });

  it("맨 끝: end 는 total 로 잘리고 아래 패딩 0", () => {
    const r = windowRange({ ...base, scrollTop: 1000 * 40 - 400 });
    expect(r.end).toBe(1000);
    expect(r.start).toBe(980);
    expect(r.bottomPad).toBe(0);
    expect(r.topPad).toBe(980 * 40);
  });

  it("표를 지나쳐 스크롤해도 범위가 뒤집히지 않는다", () => {
    const r = windowRange({ ...base, scrollTop: 999999 });
    expect(r.start).toBeLessThanOrEqual(r.end);
    expect(r.end).toBe(1000);
    expect(r.bottomPad).toBe(0);
  });

  it("overscan 지정값을 쓴다", () => {
    const r = windowRange({ ...base, scrollTop: 4000, overscan: 3 });
    expect(r.start).toBe(97);
    expect(r.end).toBe(113);
  });

  it("total 이 뷰포트보다 작으면 전부, 패딩 0", () => {
    const r = windowRange({ ...base, total: 5 });
    expect(r).toEqual({ start: 0, end: 5, topPad: 0, bottomPad: 0 });
  });

  it("total 0", () => {
    expect(windowRange({ ...base, total: 0 })).toEqual({ start: 0, end: 0, topPad: 0, bottomPad: 0 });
  });

  it("rowHeight 가 바뀌면 같은 스크롤에서 범위·패딩이 다시 계산된다", () => {
    const a = windowRange({ ...base, scrollTop: 4000, overscan: 0 });
    const b = windowRange({ ...base, scrollTop: 4000, rowHeight: 80, overscan: 0 });
    expect(a.start).toBe(100);
    expect(b.start).toBe(50);
    expect(b.end).toBe(55);
    expect(b.topPad).toBe(50 * 80);
    expect(b.bottomPad).toBe((1000 - 55) * 80);
  });

  it("rowHeight 0·음수·NaN 이면 기본값으로 계산한다", () => {
    for (const rowHeight of [0, -5, Number.NaN]) {
      expect(windowRange({ ...base, rowHeight })).toEqual(windowRange(base));
    }
  });

  it("뷰포트 0(측정 전)이어도 overscan 만큼은 그린다", () => {
    const r = windowRange({ ...base, viewportHeight: 0 });
    expect(r.start).toBe(0);
    expect(r.end).toBe(10);
  });
});

describe("windowSegments", () => {
  const base = { start: 90, end: 130, total: 300, rowHeight: 40 };
  const rendered = (segs: ReturnType<typeof windowSegments>) =>
    segs.flatMap((s) => (s.kind === "rows" ? Array.from({ length: s.to - s.from }, (_, i) => s.from + i) : []));
  const height = (segs: ReturnType<typeof windowSegments>) =>
    segs.reduce((h, s) => h + (s.kind === "pad" ? s.height : (s.to - s.from) * 40), 0);

  it("pin 이 없거나 창 안이면 위 스페이서·창·아래 스페이서", () => {
    for (const pin of [null, undefined, 100, -1, 300]) {
      expect(windowSegments({ ...base, pin })).toEqual([
        { kind: "pad", key: "__vpad-top", height: 90 * 40 },
        { kind: "rows", from: 90, to: 130 },
        { kind: "pad", key: "__vpad-bottom", height: 170 * 40 },
      ]);
    }
  });

  it("pin 이 창 위면 제자리에 한 행을 끼우고 스페이서를 나눈다 — 전체 높이는 그대로", () => {
    const segs = windowSegments({ ...base, pin: 5 });
    expect(segs).toEqual([
      { kind: "pad", key: "__vpad-top", height: 5 * 40 },
      { kind: "rows", from: 5, to: 6 },
      { kind: "pad", key: "__vpad-mid", height: 84 * 40 },
      { kind: "rows", from: 90, to: 130 },
      { kind: "pad", key: "__vpad-bottom", height: 170 * 40 },
    ]);
    expect(rendered(segs)[0]).toBe(5);
    expect(height(segs)).toBe(300 * 40);
  });

  it("pin 이 창 아래면 아래쪽에 끼운다, 창 바로 옆·맨 끝도 높이 0 스페이서 없이", () => {
    const segs = windowSegments({ ...base, pin: 299 });
    expect(segs.at(-1)).toEqual({ kind: "rows", from: 299, to: 300 });
    expect(height(segs)).toBe(300 * 40);
    const adj = windowSegments({ ...base, pin: 130 });
    expect(adj.filter((s) => s.kind === "pad" && s.key === "__vpad-mid")).toEqual([]);
    expect(rendered(adj)).toContain(130);
    expect(height(adj)).toBe(300 * 40);
    const top = windowSegments({ ...base, start: 0, end: 30, pin: 200 });
    expect(top[0]).toEqual({ kind: "rows", from: 0, to: 30 });
  });
});

describe("virtualDisabled — 가상 스크롤 해제 플래그", () => {
  const store = (v: string | null) => ({ getItem: (k: string) => (k === "ws-table-virtual" ? v : null) });
  it("?virtual=0 이나 localStorage ws-table-virtual=0 이면 끈다", () => {
    expect(virtualDisabled("?virtual=0", null)).toBe(true);
    expect(virtualDisabled("?view=table&virtual=0", store(null))).toBe(true);
    expect(virtualDisabled("", store("0"))).toBe(true);
  });
  it("그 밖의 값·없음은 켠 채로 둔다", () => {
    expect(virtualDisabled("", null)).toBe(false);
    expect(virtualDisabled("?virtual=1", store("1"))).toBe(false);
    expect(virtualDisabled("", store(null))).toBe(false);
  });
  it("저장소 접근이 throw 해도 켠 채로 둔다", () => {
    const broken = { getItem: () => { throw new Error("SecurityError"); } };
    expect(virtualDisabled("", broken)).toBe(false);
  });
});
