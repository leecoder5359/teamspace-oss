import { describe, expect, it } from "vitest";
import { applyTaskListFilter, clampLimit, clampLimitArg, isOpenStatus } from "./taskFilter";

describe("isOpenStatus", () => {
  it("null·진행 중은 open", () => {
    expect(isOpenStatus(null)).toBe(true);
    expect(isOpenStatus("진행 중")).toBe(true);
    expect(isOpenStatus("할 일")).toBe(true);
  });
  it("완료·Done·취소 등은 closed", () => {
    for (const s of ["완료", "Done", "done", "취소", "Closed", "close", "canceled", "Cancelled", "archived"]) {
      expect(isOpenStatus(s)).toBe(false);
    }
  });
});

describe("isOpenStatus 확장 사전", () => {
  it("완료됨·Completed·종료·Won't do 등은 closed", () => {
    for (const s of ["완료됨", "Completed", "종료", "종결", "Won't do", "Wont do", "resolved", "취소됨", " 완료 ", "폐기"]) {
      expect(isOpenStatus(s)).toBe(false);
    }
  });
  it("보류·대기·검토·완료 예정 등은 open", () => {
    for (const s of ["보류", "대기", "검토", "Blocked", "Backlog", "완료 예정", "마감", "중단", "In Review", "할 일", "진행 중"]) {
      expect(isOpenStatus(s)).toBe(true);
    }
  });
});

describe("clampLimitArg (CLI --limit)", () => {
  it("범위 1..200, 해석 불가·0·음수는 50", () => {
    expect(clampLimitArg("7")).toBe(7);
    expect(clampLimitArg("9999")).toBe(200);
    expect(clampLimitArg("0")).toBe(50);
    expect(clampLimitArg("-4")).toBe(50);
    expect(clampLimitArg("abc")).toBe(50);
    expect(clampLimitArg("")).toBe(50);
    expect(clampLimitArg(undefined)).toBe(50);
    expect(clampLimitArg("3.9")).toBe(3);
  });
});

describe("clampLimit", () => {
  it("0·음수·NaN·undefined → 50, 범위 1..200", () => {
    expect(clampLimit(0)).toBe(50);
    expect(clampLimit(-3)).toBe(50);
    expect(clampLimit(NaN)).toBe(50);
    expect(clampLimit(undefined)).toBe(50);
    expect(clampLimit(999)).toBe(200);
    expect(clampLimit(7)).toBe(7);
  });
});

describe("applyTaskListFilter", () => {
  const rows = [
    { id: "a", status: "진행 중" },
    { id: "b", status: "완료" },
    { id: "c", status: null },
    { id: "d", status: "Done" },
  ];
  it("open 은 닫힌 것을 빼고 total 은 전체 수(필터 전)가 아니라 필터 후 수", () => {
    const r = applyTaskListFilter(rows, { status: "open", limit: 50 });
    expect(r.tasks.map((t) => t.id)).toEqual(["a", "c"]);
    expect(r.total).toBe(2);
    expect(r.shown).toBe(2);
  });
  it("all 은 전부, limit 로 자르고 total 은 유지", () => {
    const r = applyTaskListFilter(rows, { status: "all", limit: 3 });
    expect(r.total).toBe(4);
    expect(r.shown).toBe(3);
    expect(r.tasks).toHaveLength(3);
  });
  it("limit=all 은 상한 없이 전부", () => {
    const many = Array.from({ length: 521 }, (_, i) => ({ id: String(i), status: "진행 중" }));
    expect(applyTaskListFilter(many, { status: "all", limit: "all" }).shown).toBe(521);
    expect(applyTaskListFilter(many, { status: "all" }).shown).toBe(50);
    expect(applyTaskListFilter(many, { status: "all", limit: 999 }).shown).toBe(200);
  });
});
