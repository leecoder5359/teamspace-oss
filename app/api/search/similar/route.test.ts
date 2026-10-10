import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { page: { count: vi.fn(), findMany: vi.fn() } } }));
vi.mock("@/lib/pageGuard", () => ({
  loadAccess: vi.fn(async () => ({})),
  pageAccess: vi.fn((_i: unknown, id: string) => (id === "h" ? "none" : "view")),
  visibleOnly: vi.fn((_i: unknown, rows: { id: string }[]) => rows.filter((r) => r.id !== "h")),
}));

import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { GET } from "./route";

const m = (f: unknown) => f as Mock;
const at = new Date("2026-10-09T00:00:00Z");
const TREE = [
  { id: "f", parentId: null, archivedAt: at },
  { id: "c", parentId: "f", archivedAt: null },
  { id: "a", parentId: null, archivedAt: null },
  { id: "b", parentId: null, archivedAt: null },
  { id: "h", parentId: null, archivedAt: at },
];
const DOCS = [
  { id: "a", title: "배포 절차", markdown: "배포 서버 롤백 절차 정리", project: null },
  { id: "b", title: "배포 회고", markdown: "배포 서버 롤백 회고", project: null },
  { id: "c", title: "옛 배포", markdown: "배포 서버 롤백 옛 기록", project: null },
  { id: "h", title: "숨김", markdown: "배포 서버 롤백 비밀", project: null },
];
const ids = async (res: Response) => (await res.json()).results.map((r: { id: string }) => r.id).sort();

describe("GET /api/search/similar — 보관 제외", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor" });
    m(prisma.page.count).mockResolvedValue(2);
    m(prisma.page.findMany).mockImplementation(async (args: { where: { kind?: string } }) => (args.where.kind ? DOCS : TREE));
  });
  it("q 검색 결과에 보관 폴더 아래 문서가 없다", async () => {
    expect(await ids(await GET(new Request("http://t/api/search/similar?q=배포 롤백")))).toEqual(["a", "b"]);
  });
  it("?archived=1 이면 포함(못 보는 문서는 여전히 제외)", async () => {
    expect(await ids(await GET(new Request("http://t/api/search/similar?q=배포 롤백&archived=1")))).toEqual(["a", "b", "c"]);
  });
  it("보관 문서를 기준으로 한 이웃 찾기는 되고, 결과는 활성 문서만", async () => {
    expect(await ids(await GET(new Request("http://t/api/search/similar?pageId=c")))).toEqual(["a", "b"]);
  });
});
