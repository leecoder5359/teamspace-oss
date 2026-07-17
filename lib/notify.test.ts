import { describe, it, expect } from "vitest";
import { selectRules } from "@/lib/notify";

const R = (id: string, projectId: string | null) => ({ id, projectId });

describe("selectRules", () => {
  it("프로젝트 규칙 있으면 그것만(전역 제외)", () => {
    const rules = [R("g", null), R("p", "P1"), R("p2", "P1"), R("o", "OTHER")];
    expect(selectRules(rules, "P1").map((r) => r.id)).toEqual(["p", "p2"]);
  });
  it("프로젝트 규칙 없으면 전역(null)만", () => {
    const rules = [R("g", null), R("o", "OTHER")];
    expect(selectRules(rules, "P1").map((r) => r.id)).toEqual(["g"]);
  });
  it("projectId=null 입력 → 전역만", () => {
    const rules = [R("g", null), R("p", "P1")];
    expect(selectRules(rules, null).map((r) => r.id)).toEqual(["g"]);
  });
  it("빈 목록 → 빈", () => {
    expect(selectRules([], "P1")).toEqual([]);
  });
});
