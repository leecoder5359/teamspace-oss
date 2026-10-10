import { describe, expect, it } from "vitest";
import { groupDocs, type GroupDoc } from "./docsGroup";

const doc = (id: string, over: Partial<GroupDoc> = {}): GroupDoc => ({
  id,
  title: `t-${id}`,
  parentId: null,
  projectId: null,
  updatedAt: "2026-01-01T00:00:00Z",
  ...over,
});
const projects = [
  { id: "p1", name: "반장" },
  { id: "p2", name: "로요" },
];

describe("groupDocs", () => {
  it("검색어가 있으면 평면 1그룹(label null, 최신순)", () => {
    const r = groupDocs(
      [doc("a", { updatedAt: "2026-01-01T00:00:00Z" }), doc("b", { updatedAt: "2026-02-01T00:00:00Z" })],
      { projectId: "", projects, query: " x " },
    );
    expect(r.mode).toBe("flat");
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].label).toBeNull();
    expect(r.groups[0].docs.map((d) => d.id)).toEqual(["b", "a"]);
  });

  it("전체: 프로젝트별, 그룹은 최신순, 미분류는 맨 끝(더 최신이어도)", () => {
    const r = groupDocs(
      [
        doc("a", { projectId: "p1", updatedAt: "2026-01-01T00:00:00Z" }),
        doc("b", { projectId: "p2", updatedAt: "2026-03-01T00:00:00Z" }),
        doc("c", { projectId: null, updatedAt: "2026-09-01T00:00:00Z" }),
        doc("d", { projectId: "p1", updatedAt: "2026-02-01T00:00:00Z" }),
      ],
      { projectId: "", projects, query: "" },
    );
    expect(r.mode).toBe("byProject");
    expect(r.groups.map((g) => g.label)).toEqual(["로요", "반장", "미분류"]);
    expect(r.groups[1].docs.map((d) => d.id)).toEqual(["d", "a"]);
  });

  it("폴더 모드: 2단 중첩도 최상위 조상 그룹, 루트 자신 포함, 라벨=루트 제목", () => {
    const r = groupDocs(
      [
        doc("root", { title: "기획", projectId: "p1", updatedAt: "2026-01-01T00:00:00Z" }),
        doc("mid", { parentId: "root", projectId: "p1", updatedAt: "2026-01-02T00:00:00Z" }),
        doc("leaf", { parentId: "mid", projectId: "p1", updatedAt: "2026-01-03T00:00:00Z" }),
      ],
      { projectId: "p1", projects, query: "" },
    );
    expect(r.mode).toBe("byFolder");
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].label).toBe("기획");
    expect(r.groups[0].docs.map((d) => d.id)).toEqual(["leaf", "mid", "root"]);
  });

  it("폴더 모드: 단독 문서는 '폴더 없음' 맨 끝, 그룹은 최신순", () => {
    const r = groupDocs(
      [
        doc("a", { title: "A", updatedAt: "2026-01-01T00:00:00Z" }),
        doc("a1", { parentId: "a", updatedAt: "2026-01-02T00:00:00Z" }),
        doc("b", { title: "B", updatedAt: "2026-01-03T00:00:00Z" }),
        doc("b1", { parentId: "b", updatedAt: "2026-01-04T00:00:00Z" }),
        doc("solo", { updatedAt: "2026-12-01T00:00:00Z" }),
      ],
      { projectId: "pX", projects, query: "" },
    );
    expect(r.groups.map((g) => g.label)).toEqual(["B", "A", "폴더 없음"]);
    expect(r.groups[2].docs.map((d) => d.id)).toEqual(["solo"]);
  });

  it("부모가 목록에 없으면 그 문서가 가장 위 조상, 순환 참조에도 멈춘다", () => {
    const r = groupDocs(
      [
        doc("x", { parentId: "gone", title: "X" }),
        doc("y", { parentId: "x" }),
        doc("c1", { parentId: "c2" }),
        doc("c2", { parentId: "c1" }),
      ],
      { projectId: "p1", projects, query: "" },
    );
    expect(r.groups.find((g) => g.label === "X")?.docs.map((d) => d.id).sort()).toEqual(["x", "y"]);
    expect(r.groups.flatMap((g) => g.docs)).toHaveLength(4);
  });

  it("보관 프로젝트 문서는 `이름 (보관)` 그룹으로 남는다(미분류 아님)", () => {
    const r = groupDocs([doc("a", { projectId: "p1" }), doc("b", { projectId: "p2" })], {
      projectId: "",
     
      projects: [{ id: "p1", name: "반장", archivedAt: "2026-10-01T00:00:00Z" }, { id: "p2", name: "로요", archivedAt: null }],
      query: "",
    });
    expect(r.groups.map((g) => g.label).sort()).toEqual(["로요", "반장 (보관)"]);
  });

  it("등록되지 않은 프로젝트 id 의 문서는 미분류로 모은다", () => {
    const r = groupDocs([doc("a", { projectId: "p1" }), doc("x", { projectId: "ghost" }), doc("n", { projectId: null })], {
      projectId: "",
      projects,
      query: "",
    });
    expect(r.groups.map((g) => g.label)).toEqual(["반장", "미분류"]);
    expect(r.groups[1].docs.map((d) => d.id).sort()).toEqual(["n", "x"]);
  });
});
