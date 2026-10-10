import { describe, it, expect, vi } from "vitest";
import { archivedPageIds, loadArchivedPageIds, excludeArchived } from "./pageArchive";

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

describe("loadArchivedPageIds", () => {
  const fake = (count: number, tree: ReturnType<typeof n>[]) => {
    const page = { count: vi.fn(async () => count), findMany: vi.fn(async () => tree) };
    return { db: { page }, page };
  };
  it("보관된 페이지가 하나도 없으면 트리를 읽지 않고 빈 집합", async () => {
    const { db, page } = fake(0, [n("a", null)]);
    const s = await loadArchivedPageIds(db, "w1");
    expect(s.size).toBe(0);
    expect(page.count).toHaveBeenCalledWith({ where: { workspaceId: "w1", deletedAt: null, archivedAt: { not: null } } });
    expect(page.findMany).not.toHaveBeenCalled();
  });
  it("있으면 워크스페이스 트리를 읽어 조상 규칙으로 계산", async () => {
    const { db, page } = fake(1, [n("f", null, true), n("c", "f"), n("x", null)]);
    const s = await loadArchivedPageIds(db, "w1");
    expect([...s].sort()).toEqual(["c", "f"]);
    expect(page.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "w1", deletedAt: null },
      select: { id: true, parentId: true, archivedAt: true },
    });
  });
});

describe("excludeArchived", () => {
  it("보관 집합에 든 행을 빼고 순서를 유지", () => {
    const rows = [{ id: "a", t: 1 }, { id: "b", t: 2 }, { id: "c", t: 3 }];
    expect(excludeArchived(rows, new Set(["b"]))).toEqual([{ id: "a", t: 1 }, { id: "c", t: 3 }]);
  });
  it("빈 집합이면 그대로(복사본)", () => {
    const rows = [{ id: "a" }];
    const out = excludeArchived(rows, new Set());
    expect(out).toEqual(rows);
    expect(out).not.toBe(rows);
  });
});
