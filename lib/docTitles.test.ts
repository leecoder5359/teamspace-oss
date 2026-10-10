import { describe, it, expect, vi } from "vitest";
import { normalizeTitle, isPlaceholderTitle, findDuplicateTitles, findSameTitleDocs } from "./docTitles";

describe("normalizeTitle", () => {
  it("공백·대소문자·NFC 를 정리한다", () => {
    expect(normalizeTitle("  Hello   World ")).toBe("hello world");
    expect(normalizeTitle("한")).toBe(normalizeTitle("한"));
  });
});

describe("isPlaceholderTitle", () => {
  it.each(["", "  ", "Untitled", "제목  없음", "New Page"])("%j 는 기본 제목", (t) => {
    expect(isPlaceholderTitle(t)).toBe(true);
  });
  it("일반 제목은 아니다", () => expect(isPlaceholderTitle("설계")).toBe(false));
});

describe("findDuplicateTitles", () => {
  it("같은 프로젝트 같은 제목은 서로를 가리킨다", () => {
    const m = findDuplicateTitles([
      { id: "a", title: "설계", projectId: "p" },
      { id: "b", title: " 설계 ", projectId: "p" },
      { id: "c", title: "다른", projectId: "p" },
    ]);
    expect(m.get("a")).toEqual(["b"]);
    expect(m.get("b")).toEqual(["a"]);
    expect(m.has("c")).toBe(false);
  });
  it("프로젝트가 다르면 중복 아님", () => {
    expect(findDuplicateTitles([{ id: "a", title: "x", projectId: "p" }, { id: "b", title: "x", projectId: null }]).size).toBe(0);
  });
  it("database·기본 제목은 무시, kind 생략은 doc", () => {
    const m = findDuplicateTitles([
      { id: "a", title: "x", projectId: null, kind: "database" },
      { id: "b", title: "x", projectId: null, kind: "doc" },
      { id: "c", title: "Untitled", projectId: null },
      { id: "d", title: "untitled", projectId: null },
      { id: "e", title: "X", projectId: null },
    ]);
    expect([...m.keys()].sort()).toEqual(["b", "e"]);
  });
  it("입력을 바꾸지 않는다", () => {
    const input = Object.freeze([Object.freeze({ id: "a", title: "x", projectId: null }), Object.freeze({ id: "b", title: "x", projectId: null })]);
    expect(() => findDuplicateTitles(input)).not.toThrow();
  });
});

describe("findSameTitleDocs", () => {
  const mk = () => {
    const findMany = vi.fn(async () => [{ id: "z", title: "T" }]);
    return { db: { page: { findMany } } as never, findMany };
  };
  it("where 절(제목 조건 없이 같은 프로젝트 후보를 가져온다)", async () => {
    const { db, findMany } = mk();
    await findSameTitleDocs(db, { workspaceId: "w", projectId: null, title: " T ", excludeId: "me" });
    expect(findMany).toHaveBeenCalledWith({
      where: { workspaceId: "w", projectId: null, kind: "doc", deletedAt: null, id: { not: "me" } },
      take: 500,
      select: { id: true, title: true },
    });
  });
  it("excludeId 없으면 id 조건 없음", async () => {
    const { db, findMany } = mk();
    await findSameTitleDocs(db, { workspaceId: "w", projectId: "p", title: "T" });
    expect((findMany.mock.calls[0] as unknown as [{ where: object }])[0].where).not.toHaveProperty("id");
  });
  it("normalizeTitle 로 JS 비교 — 안쪽 공백·대소문자·NFC/NFD 한글", async () => {
    const findMany = vi.fn(async () => [
      { id: "1", title: "a  b" },
      { id: "2", title: "A B" },
      { id: "3", title: "한글".normalize("NFD") },
      { id: "4", title: "other" },
    ]);
    const db = { page: { findMany } } as never;
    expect((await findSameTitleDocs(db, { workspaceId: "w", projectId: null, title: "a b" })).map((r) => r.id)).toEqual(["1", "2"]);
    expect((await findSameTitleDocs(db, { workspaceId: "w", projectId: null, title: "한글".normalize("NFC") })).map((r) => r.id)).toEqual(["3"]);
  });
  it("기본 제목은 쿼리하지 않는다", async () => {
    const { db, findMany } = mk();
    expect(await findSameTitleDocs(db, { workspaceId: "w", projectId: null, title: "Untitled" })).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
