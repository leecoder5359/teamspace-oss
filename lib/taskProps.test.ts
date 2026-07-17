import { describe, expect, it } from "vitest";
import { findAssigneeProp, findDateProp, findStatusProp, findTitleProp, optionIdByName } from "./taskProps";

const PROPS = [
  { id: "t", name: "이름", type: "text" },
  { id: "s", name: "상태", type: "select", config: { options: [{ id: "o1", name: "할 일" }, { id: "o2", name: "진행 중" }, { id: "o3", name: "완료" }] } },
  { id: "p", name: "우선순위", type: "select", config: { options: [{ id: "hi", name: "높음" }] } },
  { id: "a", name: "담당자", type: "text" },
  { id: "d", name: "마감일", type: "date" },
];

describe("taskProps 휴리스틱", () => {
  it("기본 템플릿 속성을 정확히 찾는다", () => {
    expect(findTitleProp(PROPS)?.id).toBe("t");
    expect(findStatusProp(PROPS)?.id).toBe("s"); // '우선순위'가 아니라 '상태'
    expect(findAssigneeProp(PROPS)?.id).toBe("a");
    expect(findDateProp(PROPS)?.id).toBe("d");
  });
  it("상태 이름이 영어(status)여도 찾는다", () => {
    expect(findStatusProp([{ id: "x", name: "Status", type: "select", config: { options: [] } }])?.id).toBe("x");
  });
  it("담당자 없으면 null (첫 select 로 오검출하지 않음)", () => {
    expect(findAssigneeProp([{ id: "s", name: "상태", type: "select" }])).toBeNull();
  });
  it("optionIdByName: 정확 일치 우선, 시작 일치 폴백, 없으면 null", () => {
    const s = PROPS[1];
    expect(optionIdByName(s, "진행 중")).toBe("o2");
    expect(optionIdByName(s, "진행")).toBe("o2");
    expect(optionIdByName(s, "없는상태")).toBeNull();
    expect(optionIdByName(null, "진행 중")).toBeNull();
  });
});
