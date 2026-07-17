import { describe, expect, it } from "vitest";
import { checkBaseRev, checkExpectedUpdatedAt } from "./concurrency";

describe("checkBaseRev (문서 낙관적 잠금)", () => {
  it("baseRev 미제공(opt-in) → 항상 통과", () => {
    expect(checkBaseRev(undefined, 5)).toEqual({ ok: true });
    expect(checkBaseRev(null, 5)).toEqual({ ok: true });
  });
  it("일치 → 통과, 불일치 → 충돌", () => {
    expect(checkBaseRev(5, 5)).toEqual({ ok: true });
    expect(checkBaseRev(4, 5)).toEqual({ ok: false, currentRev: 5 });
    expect(checkBaseRev(6, 5)).toEqual({ ok: false, currentRev: 5 });
  });
  it("숫자가 아닌 값은 무시(통과)하지 않고 충돌로 취급하지 않는다 — 파싱 실패는 미제공과 동일", () => {
    expect(checkBaseRev("abc" as unknown as number, 5)).toEqual({ ok: true });
  });
});

describe("checkExpectedUpdatedAt (행 낙관적 잠금)", () => {
  const now = new Date("2026-07-05T10:00:00.000Z");
  it("미제공 → 통과", () => {
    expect(checkExpectedUpdatedAt(undefined, now).ok).toBe(true);
  });
  it("동일 시각 → 통과 (ISO 문자열 비교)", () => {
    expect(checkExpectedUpdatedAt("2026-07-05T10:00:00.000Z", now).ok).toBe(true);
  });
  it("다른 시각 → 충돌 + 현재 시각 반환", () => {
    const r = checkExpectedUpdatedAt("2026-07-05T09:59:59.000Z", now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.currentUpdatedAt).toBe("2026-07-05T10:00:00.000Z");
  });
  it("파싱 불가 문자열 → 미제공과 동일(통과)", () => {
    expect(checkExpectedUpdatedAt("not-a-date", now).ok).toBe(true);
  });
});
