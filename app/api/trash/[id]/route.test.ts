import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/pageGuard", () => ({ requirePage: vi.fn() }));
vi.mock("@/lib/graphLoad", () => ({ invalidateGraphCache: vi.fn() }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/docFiles", () => ({ resolveDocPath: (p: string) => `/nonexistent/${p}` }));
vi.mock("@/lib/content", () => ({ deleteContent: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    page: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn() },
    graphEdge: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { requireCtx } from "@/lib/workspace";
import { requirePage } from "@/lib/pageGuard";
import { invalidateGraphCache } from "@/lib/graphLoad";
import { prisma } from "@/lib/prisma";
import { DELETE, POST } from "./route";

const m = (f: unknown) => f as Mock;
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request("http://t/api/trash/p1", { method: "DELETE" });
const trashed = { id: "p1", workspaceId: "w1", deletedAt: new Date(), kind: "doc", filePath: null, title: "T", children: [] };

describe("DELETE /api/trash/[id] (영구 삭제)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor" });
    m(requirePage).mockResolvedValue({ page: { id: "p1" } });
    m(prisma.page.findUnique).mockResolvedValue(trashed);
    m(prisma.page.updateMany).mockReturnValue("OP_UPDATE");
    m(prisma.page.delete).mockReturnValue("OP_DELETE");
    m(prisma.graphEdge.deleteMany).mockReturnValue("OP_EDGES");
    m(prisma.$transaction).mockResolvedValue([]);
  });

  it("A2: 같은 트랜잭션에서 이 페이지를 끝점으로 하는 GraphEdge 를 지우고 그래프 캐시를 비운다", async () => {
    const res = await DELETE(req(), ctx("p1"));
    expect(res.status).toBe(200);
    expect(prisma.graphEdge.deleteMany).toHaveBeenCalledWith({ where: { workspaceId: "w1", OR: [{ fromId: "p1" }, { toId: "p1" }] } });
    const ops = m(prisma.$transaction).mock.calls[0][0] as unknown[];
    expect(ops).toContain("OP_EDGES");
    expect(ops).toContain("OP_DELETE");
    expect(invalidateGraphCache).toHaveBeenCalledWith("w1");
  });

  it("휴지통에 없는 페이지 → 404, 간선·캐시 그대로", async () => {
    m(prisma.page.findUnique).mockResolvedValue({ ...trashed, deletedAt: null });
    expect((await DELETE(req(), ctx("p1"))).status).toBe(404);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(invalidateGraphCache).not.toHaveBeenCalled();
  });

  it("살아 있는 자식 → 409, 캐시 그대로", async () => {
    m(prisma.page.findUnique).mockResolvedValue({ ...trashed, children: [{ deletedAt: null }] });
    expect((await DELETE(req(), ctx("p1"))).status).toBe(409);
    expect(invalidateGraphCache).not.toHaveBeenCalled();
  });
});

describe("POST /api/trash/[id] (복원) — A5", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor" });
    m(requirePage).mockResolvedValue({ page: { id: "p1" } });
  });

  it("복원 성공 → 그래프 캐시 무효화", async () => {
    m(prisma.page.findUnique).mockResolvedValue({ ...trashed, parentId: null, parent: null });
    expect((await POST(req(), ctx("p1"))).status).toBe(200);
    expect(invalidateGraphCache).toHaveBeenCalledWith("w1");
  });

  it("휴지통에 없음 → 404, 무효화 안 함", async () => {
    m(prisma.page.findUnique).mockResolvedValue(null);
    expect((await POST(req(), ctx("p1"))).status).toBe(404);
    expect(invalidateGraphCache).not.toHaveBeenCalled();
  });
});
