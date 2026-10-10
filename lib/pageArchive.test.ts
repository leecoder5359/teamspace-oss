import { describe, it, expect } from "vitest";
import { archivedPageIds } from "./pageArchive";

const at = new Date("2026-10-09T00:00:00Z");
const n = (id: string, parentId: string | null, archived = false) => ({ id, parentId, archivedAt: archived ? at : null });

describe("archivedPageIds", () => {
  it("보관 없으면 빈 집합", () => {
    expect(archivedPageIds([n("a", null), n("b", "a")]).size).toBe(0);
  });
  it("스스로 보관 + 모든 후손", () => {
    const s = archivedPageIds([n("a", null, true), n("b", "a"), n("c", "b"), n("x", null)]);
    expect([...s].sort()).toEqual(["a", "b", "c"]);
  });
  it("자식만 보관하면 부모는 활성", () => {
    expect([...archivedPageIds([n("a", null), n("b", "a", true)])]).toEqual(["b"]);
  });
  it("깊은 사슬(10000단계)도 처리", () => {
    const pages = [n("p0", null, true)];
    for (let i = 1; i < 10000; i++) pages.push(n(`p${i}`, `p${i - 1}`));
    expect(archivedPageIds(pages).size).toBe(10000);
  });
  it("순환 참조에서 멈춘다 — 표식 없으면 활성, 있으면 고리 전체", () => {
    expect(archivedPageIds([n("a", "b"), n("b", "a")]).size).toBe(0);
    expect([...archivedPageIds([n("a", "b", true), n("b", "a")])].sort()).toEqual(["a", "b"]);
  });
  it("부모가 목록에 없으면(삭제됨) 거기서 끝", () => {
    expect(archivedPageIds([n("a", "gone")]).size).toBe(0);
  });
});
