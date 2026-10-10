import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { page: { count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() } } }));
vi.mock("@/lib/pageGuard", () => ({ loadAccess: vi.fn(), pageAccess: vi.fn() }));
vi.mock("@/lib/favorites", () => ({ listVisits: vi.fn(), recordVisit: vi.fn() }));

import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { pageAccess } from "@/lib/pageGuard";
import { listVisits, recordVisit } from "@/lib/favorites";
import { GET, POST } from "./route";

const m = (f: unknown) => f as Mock;
const at = new Date("2026-10-09T00:00:00Z");
const TREE = [
  { id: "f", parentId: null, archivedAt: at },
  { id: "c", parentId: "f", archivedAt: null },
  { id: "a", parentId: null, archivedAt: null },
  { id: "b", parentId: null, archivedAt: null },
];
const row = (id: string) => ({ id, title: id.toUpperCase(), kind: "doc", docType: null, projectId: null });
const ids = async (res: Response) => (await res.json()).visits.map((v: { pageId: string }) => v.pageId);

describe("GET /api/visits — 보관(조상 규칙) 제외", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor" });
    m(listVisits).mockResolvedValue(["c", "a", "b"].map((pageId) => ({ pageId, visitedAt: at })));
    m(pageAccess).mockReturnValue("view");
    m(prisma.page.count).mockResolvedValue(1);
    m(prisma.page.findMany).mockImplementation(async (args: { where: { id?: { in: string[] } } }) =>
      args.where.id ? args.where.id.in.map(row) : TREE,
    );
  });
  it("보관 폴더 아래 자식은 빠지고, limit 은 남은 것 기준으로 채운다", async () => {
    expect(await ids(await GET(new Request("http://t/api/visits?limit=2")))).toEqual(["a", "b"]);
  });
  it("?archived=1 이면 남긴다", async () => {
    expect(await ids(await GET(new Request("http://t/api/visits?archived=1")))).toEqual(["c", "a", "b"]);
  });
  it("보관 페이지 방문 기록(POST)은 그대로 허용", async () => {
    m(prisma.page.findFirst).mockResolvedValue({ id: "c" });
    const res = await POST(new Request("http://t/api/visits", { method: "POST", body: JSON.stringify({ pageId: "c" }) }));
    expect(res.status).toBe(200);
    expect(recordVisit).toHaveBeenCalledWith("u1", "c", 20);
  });
});
