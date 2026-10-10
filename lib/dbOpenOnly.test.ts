import { describe, expect, it } from "vitest";
import { buildRowTree } from "./subitems";
import { openOnlyLayout, byUpdatedDesc, findStatusProp, hiddenCount, visibleRows } from "./dbOpenOnly";

const status = {
  id: "s", name: "상태", type: "select",
  config: { options: [{ id: "o1", name: "진행중" }, { id: "o2", name: "완료" }, { id: "o3", name: "취소" }] },
};
const title = { id: "t", name: "제목", type: "text", config: null };
const rows = [
  { props: { s: "o1" }, updatedAt: "2026-01-01" },
  { props: { s: "o2" }, updatedAt: "2026-03-01" },
  { props: { s: "o3" }, updatedAt: "2026-02-01" },
  { props: {}, updatedAt: "2026-04-01" },
  { props: { s: "unknown" } },
];

describe("dbOpenOnly", () => {
  it("상태 속성 탐지: select + 이름 status|상태", () => {
    expect(findStatusProp([title, status])?.id).toBe("s");
    expect(findStatusProp([title, { ...status, type: "text" }])).toBeNull();
    expect(findStatusProp([title, { ...status, name: "Status" }])?.id).toBe("s");
    expect(findStatusProp([title, { ...status, name: "우선순위" }])).toBeNull();
  });
  it("openOnly 면 완료·취소 숨김, null·모르는 옵션은 열림", () => {
    const v = visibleRows(rows, [title, status], { openOnly: true });
    expect(v).toHaveLength(3);
    expect(hiddenCount(rows, [title, status])).toBe(2);
  });
  it("openOnly 끄면 전부, 상태 속성 없으면 전부", () => {
    expect(visibleRows(rows, [title, status], { openOnly: false })).toHaveLength(5);
    expect(visibleRows(rows, [title], { openOnly: true })).toHaveLength(5);
    expect(hiddenCount(rows, [title])).toBe(0);
  });
  it("byUpdatedDesc: updatedAt 내림차순, 없으면 맨 뒤", () => {
    expect([...rows].sort(byUpdatedDesc)[0].updatedAt).toBe("2026-04-01");
    expect([...rows].sort(byUpdatedDesc).at(-1)?.updatedAt).toBeUndefined();
  });
  it("Done 상태도 닫힘으로 숨긴다", () => {
    const p = { ...status, config: { options: [{ id: "d", name: "Done" }, { id: "i", name: "In progress" }] } };
    const r = [{ props: { s: "d" } }, { props: { s: "i" } }];
    expect(visibleRows(r, [p], { openOnly: true })).toHaveLength(1);
  });
  it("최종 표시 순서: 최상위는 updatedAt 내림차순, 서브아이템은 부모 아래 트리 유지", () => {
    const r = [
      { id: "a", position: 0, props: { s: "o1" }, updatedAt: "2026-01-01" },
      { id: "b", position: 1, props: { s: "o1" }, updatedAt: "2026-03-01" },
      { id: "c", position: 2, props: { s: "o2" }, updatedAt: "2026-05-01" },
      { id: "d", position: 3, props: {}, updatedAt: "2026-02-01" },
      { id: "a1", position: 4, parentRowId: "a", props: { s: "o1" }, updatedAt: "2026-09-01" },
    ];
    const lay = openOnlyLayout(r, [title, status], { openOnly: true, hasViewSort: false });
    expect(lay.rootCompare).toBeDefined();
    expect(lay.hidden).toBe(1);
    const tree = buildRowTree(lay.rows, new Set(), { rootCompare: lay.rootCompare });
    // a1 은 수정 시각이 가장 늦어도 최상위로 튀어나오지 않고 a 아래에 남는다
    expect(tree.map((x) => [x.id, x.depth])).toEqual([["b", 0], ["d", 0], ["a", 0], ["a1", 1]]);
    expect(openOnlyLayout(r, [title, status], { openOnly: true, hasViewSort: true }).rootCompare).toBeUndefined();
    expect(openOnlyLayout(r, [title, status], { openOnly: false, hasViewSort: false })).toEqual({ rows: r, kept: new Set(), hidden: 0 });
  });
  it("방금 편집한 닫힌 행(keepIds)은 남기고 kept 로 알린다 — 숨김 수에서 빠진다", () => {
    const r = [
      { id: "x", props: { s: "o2" }, updatedAt: "2026-05-01" },
      { id: "y", props: { s: "o3" }, updatedAt: "2026-04-01" },
      { id: "z", props: { s: "o1" }, updatedAt: "2026-03-01" },
    ];
    const lay = openOnlyLayout(r, [title, status], { openOnly: true, hasViewSort: false, keepIds: new Set(["x", "z"]) });
    expect(lay.rows.map((x) => x.id)).toEqual(["x", "z"]);
    expect([...lay.kept]).toEqual(["x"]); // 열린 z 는 원래 보이므로 흐리게 하지 않는다
    expect(lay.hidden).toBe(1);
  });
});
