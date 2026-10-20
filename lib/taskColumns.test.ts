import { describe, expect, it } from "vitest";
import { closedOptionIds, deriveTaskColumns, taskColsKey } from "./taskColumns";

const status = { id: "pS", name: "상태", type: "select", config: { options: [{ id: "o1", name: "할 일" }, { id: "o2", name: "진행 중" }, { id: "o3", name: "완료" }] } };
const priority = { id: "pP", name: "우선순위", type: "select", config: { options: [{ id: "x", name: "높음" }] } };
const title = { id: "pT", name: "제목", type: "text" };
const assignee = { id: "pA", name: "담당자", type: "text" };

describe("taskColsKey", () => {
  it("현재 속성으로 고른 상태·담당자 속성 id 를 잇는다 — 휴리스틱(lib/taskProps)과 같은 선택", () => {
    expect(taskColsKey([title, priority, status, assignee])).toBe("pS|pA"); // 이름이 '상태' 인 select 가 우선
    expect(taskColsKey([title, priority])).toBe("pP|"); // 이름 일치가 없으면 첫 select
    expect(taskColsKey([title])).toBe("|");
  });
});

describe("deriveTaskColumns", () => {
  const props = [title, status, assignee];

  it("상태 옵션 id·다듬은 담당자 이름·키를 낸다", () => {
    expect(deriveTaskColumns(props, { pT: "일", pS: "o2", pA: "  Claude  " })).toEqual({ statusOptionId: "o2", assigneeText: "Claude", taskColsKey: "pS|pA" });
  });

  it("값이 없거나 문자열이 아니면 null, 빈 담당자도 null", () => {
    expect(deriveTaskColumns(props, { pS: 3, pA: "   " })).toEqual({ statusOptionId: null, assigneeText: null, taskColsKey: "pS|pA" });
    expect(deriveTaskColumns(props, {})).toEqual({ statusOptionId: null, assigneeText: null, taskColsKey: "pS|pA" });
  });

  it("상태·담당자 속성이 없는 보드는 둘 다 null", () => {
    expect(deriveTaskColumns([title], { pT: "일" })).toEqual({ statusOptionId: null, assigneeText: null, taskColsKey: "|" });
  });

  it("입력을 바꾸지 않는다", () => {
    const row = Object.freeze({ pS: "o1", pA: " a " });
    expect(() => deriveTaskColumns(props, row)).not.toThrow();
  });
});

describe("closedOptionIds", () => {
  it("이름 판정 함수가 닫힘이라고 한 옵션 id 만", () => {
    expect(closedOptionIds(status, (n) => n === "완료")).toEqual(["o3"]);
  });

  it("상태 속성이 없으면 빈 배열", () => {
    expect(closedOptionIds(null, () => true)).toEqual([]);
  });
});
