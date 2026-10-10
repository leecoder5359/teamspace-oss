import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { page: { count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() } } }));
vi.mock("@/lib/pageGuard", () => ({ loadAccess: vi.fn(), pageAccess: vi.fn() }));
vi.mock("@/lib/favorites", () => ({
  listFavorites: vi.fn(), addFavorite: vi.fn(), removeFavorite: vi.fn(), reorderFavorites: vi.fn(),
}));

import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { pageAccess } from "@/lib/pageGuard";
import { listFavorites, addFavorite } from "@/lib/favorites";
import { GET, POST } from "./route";

const m = (f: unknown) => f as Mock;
const at = new Date("2026-10-09T00:00:00Z");
// 트리: 폴더 f(보관) ▸ c(자식, 스스로는 미보관) / a(활성) / h(못 보는 문서, 보관)
const TREE = [
  { id: "f", parentId: null, archivedAt: at },
  { id: "c", parentId: "f", archivedAt: null },
  { id: "a", parentId: null, archivedAt: null },
  { id: "h", parentId: null, archivedAt: at },
];
const row = (id: string) => ({ id, title: id.toUpperCase(), kind: "doc", docType: null, projectId: null });

describe("GET /api/favorites — 보관(조상 규칙) 제외", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor" });
    m(listFavorites).mockResolvedValue(["c", "a", "h"].map((pageId, position) => ({ pageId, position })));
    m(pageAccess).mockImplementation((_idx: unknown, id: string) => (id === "h" ? "none" : "view"));
    m(prisma.page.count).mockResolvedValue(2);
    m(prisma.page.findMany).mockImplementation(async (args: { where: { id?: { in: string[] } } }) =>
      args.where.id ? args.where.id.in.map(row) : TREE,
    );
  });
  it("보관 폴더 아래 자식은 기본 목록에서 빠진다", async () => {
    const res = await GET(new Request("http://t/api/favorites"));
    const { favorites } = await res.json();
    expect(favorites.map((f: { pageId: string }) => f.pageId)).toEqual(["a"]);
  });
  it("?archived=1 이면 보관된 것도 남긴다(가시성 필터는 그대로)", async () => {
    const res = await GET(new Request("http://t/api/favorites?archived=1"));
    const { favorites } = await res.json();
    expect(favorites.map((f: { pageId: string }) => f.pageId)).toEqual(["c", "a"]);
  });
  it("보관 페이지 즐겨찾기 추가(POST)는 그대로 허용", async () => {
    m(prisma.page.findFirst).mockResolvedValue({ id: "c" });
    const res = await POST(new Request("http://t/api/favorites", { method: "POST", body: JSON.stringify({ pageId: "c" }) }));
    expect(res.status).toBe(200);
    expect(addFavorite).toHaveBeenCalledWith("u1", "c");
  });
});
