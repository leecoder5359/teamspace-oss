import { describe, it, expect } from "vitest";
import { buildTree, groupByProject, limitChildren, defaultCollapsed, isTaskNoteFolder, resolveCollapsed, taskNoteFolderIds, NONE, type FlatPage } from "./treeModel";

const P = (o: Partial<FlatPage> & { id: string }): FlatPage => ({ title: o.id, icon: null, parentId: null, position: 0, kind: "doc", projectId: null, ...o });

describe("buildTree", () => {
  it("parentId 로 중첩하고 position 으로 정렬한다", () => {
    const roots = buildTree([P({ id: "b", position: 2 }), P({ id: "a", position: 1 }), P({ id: "a1", parentId: "a" })]);
    expect(roots.map((r) => r.id)).toEqual(["a", "b"]);
    expect(roots[0].children.map((c) => c.id)).toEqual(["a1"]);
  });
  it("부모가 목록에 없으면 뿌리로 올린다", () => {
    expect(buildTree([P({ id: "x", parentId: "ghost" })]).map((r) => r.id)).toEqual(["x"]);
  });
});

describe("groupByProject", () => {
  it("보관 프로젝트는 이름 뒤에 (보관) 을 붙이고 페이지는 그 그룹에 그대로 둔다(미분류로 안 떨어짐)", () => {
    const g = groupByProject([P({ id: "d1", projectId: "p1" }), P({ id: "d2", projectId: "p2" })], [{ id: "p1", name: "P1", archived: true }, { id: "p2", name: "P2", archived: false }]);
    expect(g.map((x) => x.name)).toEqual(["P1 (보관)", "P2"]);
    expect(g[0].roots.map((r) => r.id)).toEqual(["d1"]);
    expect(g.some((x) => x.key === NONE)).toBe(false);
  });
  it("프로젝트 순서대로, 보드와 뿌리 문서를 나누고, 미분류는 맨 뒤", () => {
    const g = groupByProject(
      [P({ id: "d1", projectId: "p1" }), P({ id: "b1", kind: "database", projectId: "p1" }), P({ id: "d2" })],
      [{ id: "p1", name: "P1" }, { id: "p2", name: "P2" }],
    );
    expect(g.map((x) => x.key)).toEqual(["p1", "p2", NONE]);
    expect(g[0].boards.map((b) => b.id)).toEqual(["b1"]);
    expect(g[0].roots.map((r) => r.id)).toEqual(["d1"]);
    expect(g[1].roots).toEqual([]);
  });
  it("미분류가 비어 있으면 그룹을 만들지 않는다", () => {
    const g = groupByProject([P({ id: "d1", projectId: "p1" })], [{ id: "p1", name: "P1" }]);
    expect(g.map((x) => x.key)).toEqual(["p1"]);
  });
  it("목록에 없는 projectId 는 미분류로 모은다", () => {
    const g = groupByProject(
      [P({ id: "d1", projectId: "gone" }), P({ id: "b1", kind: "database", projectId: "gone" })],
      [{ id: "p1", name: "P1" }],
    );
    const none = g[g.length - 1];
    expect(none.key).toBe(NONE);
    expect(none.roots.map((r) => r.id)).toEqual(["d1"]);
    expect(none.boards.map((b) => b.id)).toEqual(["b1"]);
  });
});

describe("limitChildren", () => {
  it("12개까지 보여주고 나머지 수를 알려준다, 펼치면 전부", () => {
    const items = Array.from({ length: 30 }, (_, i) => i);
    expect(limitChildren(items, false)).toEqual({ shown: items.slice(0, 12), hidden: 18 });
    expect(limitChildren(items, true).hidden).toBe(0);
    expect(limitChildren([1, 2], false)).toEqual({ shown: [1, 2], hidden: 0 });
  });
});

describe("defaultCollapsed", () => {
  it("현재 프로젝트만 펼치고, 태스크 설명 폴더는 항상 접는다", () => {
    const taskFolder = { ...P({ id: "tf", title: "태스크 설명", projectId: "p1" }), children: [{ ...P({ id: "t1", docType: "task_note", parentId: "tf" }), children: [] }] };
    const groups = groupByProject([P({ id: "d1", projectId: "p1" }), P({ id: "d2", projectId: "p2" })], [{ id: "p1", name: "P1" }, { id: "p2", name: "P2" }]);
    groups[0].roots.push(taskFolder);
    const c = defaultCollapsed(groups, "p1");
    expect(c.has("p1")).toBe(false);
    expect(c.has("p2")).toBe(true);
    expect(c.has("tf")).toBe(true);
  });
  it("현재 프로젝트가 없으면 전부 접는다", () => {
    const groups = groupByProject([P({ id: "d1", projectId: "p1" })], [{ id: "p1", name: "P1" }]);
    expect(defaultCollapsed(groups, null).has("p1")).toBe(true);
  });
});

describe("resolveCollapsed (v2 저장값·본 폴더)", () => {
  const mk = () => {
    const taskFolder = { ...P({ id: "tf", title: "태스크 설명", projectId: "p1" }), children: [{ ...P({ id: "t1", docType: "task_note", parentId: "tf" }), children: [] }] };
    const groups = groupByProject([P({ id: "d1", projectId: "p1" }), P({ id: "d2", projectId: "p2" })], [{ id: "p1", name: "P1" }, { id: "p2", name: "P2" }]);
    groups[0].roots.push(taskFolder);
    return groups;
  };
  it("저장값이 없으면 기본 접힘, 태스크 설명 폴더는 본 것으로 기록", () => {
    const r = resolveCollapsed(null, null, mk(), "p1");
    expect([...r.collapsed].sort()).toEqual(["p2", "tf"]);
    expect(r.seen).toEqual(["tf"]);
    expect(taskNoteFolderIds(mk())).toEqual(["tf"]);
  });
  it("저장값이 있어도 처음 보는 태스크 설명 폴더는 한 번 접는다", () => {
    const r = resolveCollapsed([], [], mk(), "p1");
    expect([...r.collapsed]).toEqual(["tf"]);
    expect(r.seen).toEqual(["tf"]);
  });
  it("이미 본 폴더를 사용자가 펼쳤으면 다시 접지 않는다", () => {
    const r = resolveCollapsed(["p2"], ["tf"], mk(), "p1");
    expect([...r.collapsed]).toEqual(["p2"]);
  });
});

describe("isTaskNoteFolder", () => {
  it("이름이 '태스크 설명' 이거나 자식이 전부 task_note 면 참", () => {
    expect(isTaskNoteFolder({ ...P({ id: "f", title: "태스크 설명" }), children: [] })).toBe(true);
    expect(isTaskNoteFolder({ ...P({ id: "g", title: "기타" }), children: [{ ...P({ id: "x", docType: "task_note" }), children: [] }] })).toBe(true);
    expect(isTaskNoteFolder({ ...P({ id: "h", title: "인증" }), children: [{ ...P({ id: "y", docType: "design" }), children: [] }] })).toBe(false);
  });
});
