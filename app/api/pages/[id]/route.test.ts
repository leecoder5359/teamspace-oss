import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/pageGuard", () => ({ requirePage: vi.fn(), isRestrictedPage: vi.fn() }));
vi.mock("@/lib/graphLoad", () => ({ invalidateGraphCache: vi.fn() }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/notify", () => ({ fireNotif: vi.fn() }));
vi.mock("@/lib/content", () => ({ pageFilePath: vi.fn(() => "w1/p1.md"), readContent: vi.fn(), writeContent: vi.fn() }));
vi.mock("@/lib/docFiles", () => ({
  readDoc: vi.fn(), writeDoc: vi.fn(), resolveDocPath: vi.fn(() => { throw new Error("no"); }),
  docFolderFor: vi.fn(() => "docs"), listDocFolder: vi.fn(async () => []), uniqueFileName: vi.fn(() => "t.md"),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    page: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    pageRevision: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { requireCtx } from "@/lib/workspace";
import { requirePage, isRestrictedPage } from "@/lib/pageGuard";
import { invalidateGraphCache } from "@/lib/graphLoad";
import { prisma } from "@/lib/prisma";
import { PUT, PATCH, DELETE } from "./route";

const m = (f: unknown) => f as Mock;
const ctx = { params: Promise.resolve({ id: "p1" }) };
const put = (body: unknown) => new Request("http://t/api/pages/p1", { method: "PUT", body: JSON.stringify(body) });
const patch = (body: unknown) => new Request("http://t/api/pages/p1", { method: "PATCH", body: JSON.stringify(body) });
const del = () => new Request("http://t/api/pages/p1", { method: "DELETE" });
const page = { id: "p1", workspaceId: "w1", deletedAt: null, title: "T", kind: "doc", rev: 1, markdown: "", filePath: null, project: null, projectId: null, children: [] };

describe("pages/[id] — A5 그래프 캐시 무효화", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor", actor: { name: "U" } });
    m(requirePage).mockResolvedValue({ page: { id: "p1" } });
    m(isRestrictedPage).mockResolvedValue(true);
    m(prisma.page.findUnique).mockResolvedValue(page);
    m(prisma.$transaction).mockResolvedValue([]);
  });

  it("PUT 제목만 → 성공 시 무효화", async () => {
    expect((await PUT(put({ title: "새 제목" }), ctx)).status).toBe(200);
    expect(invalidateGraphCache).toHaveBeenCalledWith("w1");
  });

  it("PUT 본문(doc) → 성공 시 무효화", async () => {
    expect((await PUT(put({ markdown: "# 본문" }), ctx)).status).toBe(200);
    expect(invalidateGraphCache).toHaveBeenCalledWith("w1");
  });

  it("PUT 본문(database) → 성공 시 무효화", async () => {
    m(prisma.page.findUnique).mockResolvedValue({ ...page, kind: "database" });
    expect((await PUT(put({ markdown: "x" }), ctx)).status).toBe(200);
    expect(invalidateGraphCache).toHaveBeenCalledWith("w1");
  });

  it("PUT 4xx(404·400·409) → 무효화 안 함", async () => {
    expect((await PUT(put({}), ctx)).status).toBe(400);
    expect((await PUT(put({ markdown: "x", baseRev: 0 }), ctx)).status).toBe(409);
    m(prisma.page.findUnique).mockResolvedValue(null);
    expect((await PUT(put({ title: "x" }), ctx)).status).toBe(404);
    expect(invalidateGraphCache).not.toHaveBeenCalled();
  });

  it("PATCH(이름·이동·프로젝트) → 성공 시 무효화, 4xx 는 안 함", async () => {
    m(prisma.page.findUnique).mockResolvedValue({ id: "p1", workspaceId: "w1" });
    expect((await PATCH(patch({}), ctx)).status).toBe(400);
    expect((await PATCH(patch({ title: "  " }), ctx)).status).toBe(400);
    expect((await PATCH(patch({ parentId: "p1" }), ctx)).status).toBe(400);
    m(prisma.page.findUnique).mockResolvedValueOnce(null);
    expect((await PATCH(patch({ title: "x" }), ctx)).status).toBe(404);
    expect(invalidateGraphCache).not.toHaveBeenCalled();
    expect((await PATCH(patch({ title: "새 이름" }), ctx)).status).toBe(200);
    expect(prisma.page.update).toHaveBeenCalled();
    expect(invalidateGraphCache).toHaveBeenCalledWith("w1");
  });

  it("DELETE(휴지통) → 성공 시 무효화, 404·409 는 안 함", async () => {
    m(prisma.page.findUnique).mockResolvedValueOnce({ ...page, children: [{ deletedAt: null }] });
    expect((await DELETE(del(), ctx)).status).toBe(409);
    m(prisma.page.findUnique).mockResolvedValueOnce(null);
    expect((await DELETE(del(), ctx)).status).toBe(404);
    expect(invalidateGraphCache).not.toHaveBeenCalled();
    expect((await DELETE(del(), ctx)).status).toBe(200);
    expect(invalidateGraphCache).toHaveBeenCalledWith("w1");
  });
});
