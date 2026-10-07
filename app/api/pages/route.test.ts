import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/pageGuard", () => ({ loadAccess: vi.fn(), visibleOnly: vi.fn(), projectAccess: vi.fn(), gatePage: vi.fn() }));
vi.mock("@/lib/pageAccess", () => ({ effectiveRestricted: vi.fn() }));
vi.mock("@/lib/projectRef", () => ({ resolveProjectRef: vi.fn() }));
vi.mock("@/lib/idempotency", () => ({ withIdempotency: (_r: unknown, _g: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/graphLoad", () => ({ invalidateGraphCache: vi.fn() }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/content", () => ({ pageFilePath: vi.fn(() => "w1/p.md"), writeContent: vi.fn() }));
vi.mock("@/lib/docFiles", () => ({ writeDoc: vi.fn(), docFolderFor: vi.fn(() => "docs"), listDocFolder: vi.fn(async () => []), uniqueFileName: vi.fn(() => "t.md") }));
vi.mock("@/lib/prisma", () => ({
  prisma: { page: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() }, project: { findUnique: vi.fn() } },
}));

import { requireCtx } from "@/lib/workspace";
import { loadAccess, projectAccess } from "@/lib/pageGuard";
import { resolveProjectRef } from "@/lib/projectRef";
import { invalidateGraphCache } from "@/lib/graphLoad";
import { prisma } from "@/lib/prisma";
import { POST } from "./route";

const m = (f: unknown) => f as Mock;
const post = (body: unknown) => new Request("http://t/api/pages", { method: "POST", body: JSON.stringify(body) });

describe("POST /api/pages — A5 그래프 캐시 무효화", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor" });
    m(loadAccess).mockResolvedValue({});
    m(resolveProjectRef).mockResolvedValue({ ok: true, projectId: null });
    m(prisma.page.findFirst).mockResolvedValue(null);
    m(prisma.page.create).mockResolvedValue({ id: "p1", title: "T", parentId: null, kind: "doc" });
  });

  it("doc 생성 성공 → 무효화", async () => {
    expect((await POST(post({ title: "T" }))).status).toBe(200);
    expect(invalidateGraphCache).toHaveBeenCalledWith("w1");
  });

  it("database 생성 성공 → 무효화", async () => {
    m(prisma.page.create).mockResolvedValue({ id: "p1", title: "T", parentId: null, kind: "database" });
    expect((await POST(post({ title: "T", kind: "database" }))).status).toBe(200);
    expect(invalidateGraphCache).toHaveBeenCalledWith("w1");
  });

  it("4xx(권한 없는 프로젝트 403·없는 부모 400) → 무효화 안 함", async () => {
    m(resolveProjectRef).mockResolvedValueOnce({ ok: true, projectId: "pr1" });
    m(projectAccess).mockReturnValueOnce("view");
    expect((await POST(post({ title: "T", projectId: "pr1" }))).status).toBe(403);
    expect((await POST(post({ title: "T", parentId: "nope" }))).status).toBe(400);
    expect(invalidateGraphCache).not.toHaveBeenCalled();
  });
});
