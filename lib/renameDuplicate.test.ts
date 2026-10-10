import { describe, expect, it, vi, beforeEach } from "vitest";

const getPages = vi.fn();
vi.mock("@/lib/pagesClient", () => ({ getPages: (o: unknown) => getPages(o) }));

import { renameCollides } from "./renameDuplicate";

const ok = (pages: unknown[]) => ({ ok: true, status: 200, data: { pages } });
beforeEach(() => {
  getPages.mockReset();
});

describe("renameCollides", () => {
  it("같은 프로젝트에 같은 제목이 있으면 true", async () => {
    getPages.mockResolvedValue(ok([
      { id: "a", title: "설계", projectId: "p1", kind: "doc" },
      { id: "b", title: " 설계 ", projectId: "p1", kind: "doc" },
    ]));
    expect(await renameCollides("a")).toBe(true);
    expect(getPages).toHaveBeenCalledWith({ fresh: true });
  });
  it("다른 프로젝트·기본 제목·실패는 false", async () => {
    getPages.mockResolvedValue(ok([
      { id: "a", title: "설계", projectId: "p1", kind: "doc" },
      { id: "b", title: "설계", projectId: "p2", kind: "doc" },
    ]));
    expect(await renameCollides("a")).toBe(false);
    getPages.mockResolvedValue(ok([{ id: "a", title: "Untitled", projectId: null }, { id: "b", title: "Untitled", projectId: null }]));
    expect(await renameCollides("a")).toBe(false);
    getPages.mockResolvedValue({ ok: false, status: 500, data: null });
    expect(await renameCollides("a")).toBe(false);
  });
  it("목록 요청이 던져도 false(경고 실패가 이름 변경을 막지 않는다)", async () => {
    getPages.mockImplementation(() => {
      throw new Error("x");
    });
    expect(await renameCollides("a")).toBe(false);
  });
});
