import { describe, it, expect } from "vitest";
import { clampLessonLimit, normalizeLessonQ, lessonTitleWhere, filterLessonsByTitle } from "./lessonQuery";

describe("clampLessonLimit", () => {
  it("비었거나 숫자가 아니면 null", () => {
    expect(clampLessonLimit(null)).toBeNull();
    expect(clampLessonLimit(undefined)).toBeNull();
    expect(clampLessonLimit("")).toBeNull();
    expect(clampLessonLimit("abc")).toBeNull();
  });
  it("1..300 으로 맞춘다", () => {
    expect(clampLessonLimit("0")).toBe(1);
    expect(clampLessonLimit(-5)).toBe(1);
    expect(clampLessonLimit("50")).toBe(50);
    expect(clampLessonLimit(12.9)).toBe(12);
    expect(clampLessonLimit("9999")).toBe(300);
  });
});

describe("normalizeLessonQ", () => {
  it("공백만이면 null, 아니면 trim", () => {
    expect(normalizeLessonQ("  ")).toBeNull();
    expect(normalizeLessonQ(null)).toBeNull();
    expect(normalizeLessonQ("  next ")).toBe("next");
  });
});

describe("lessonTitleWhere / filterLessonsByTitle", () => {
  it("where 조각", () => {
    expect(lessonTitleWhere(null)).toEqual({});
    expect(lessonTitleWhere("a")).toEqual({ title: { contains: "a", mode: "insensitive" } });
  });
  it("대소문자 무시 부분일치", () => {
    const items = [{ title: "Next 16 proxy" }, { title: "결제 규칙" }];
    expect(filterLessonsByTitle(items, "NEXT")).toEqual([items[0]]);
    expect(filterLessonsByTitle(items, "규칙")).toEqual([items[1]]);
    expect(filterLessonsByTitle(items, null)).toEqual(items);
  });
});
