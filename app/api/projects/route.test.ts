import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { project: { findUnique: vi.fn(), update: vi.fn() } } }));
vi.mock("@/lib/pageGuard", () => ({ loadAccess: vi.fn(), projectAccess: vi.fn(), requireProject: vi.fn() }));
vi.mock("@/lib/projects", () => ({ getProjectsWithStats: vi.fn() }));
vi.mock("@/lib/projectRef", () => ({ resolveMemberRef: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { loadAccess, projectAccess, requireProject } from "@/lib/pageGuard";
import { getProjectsWithStats } from "@/lib/projects";
import { GET } from "./route";
import { PATCH } from "./[id]/route";

const m = (f: unknown) => f as Mock;
const ctx = { workspaceId: "w1", userId: "u1", role: "editor", actor: { type: "user", id: "u1", name: "U" } };

describe("GET /api/projects ?archived=", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m(requireCtx).mockResolvedValue(ctx);
    m(loadAccess).mockResolvedValue({});
    m(projectAccess).mockImplementation((_i: unknown, id: string) => (id === "locked" ? "none" : "view"));
    m(getProjectsWithStats).mockResolvedValue([
      { id: "p1", archivedAt: null },
      { id: "locked", archivedAt: null },
    ]);
  });

  it.each([
    [undefined, "active"],
    ["1", "only"],
    ["true", "only"],
    ["all", "all"],
    ["junk", "active"],
  ])("?archived=%s → 모드 %s", async (q, mode) => {
    await GET(new Request(`http://t/api/projects${q ? `?archived=${q}` : ""}`));
    expect(m(getProjectsWithStats)).toHaveBeenCalledWith("w1", mode);
  });

  it("D3: 보관 여부와 무관하게 잠긴 프로젝트는 빠진다", async () => {
    const res = await GET(new Request("http://t/api/projects?archived=all"));
    const body = (await res.json()) as { projects: { id: string }[] };
    expect(body.projects.map((p) => p.id)).toEqual(["p1"]);
  });
});

describe("PATCH /api/projects/[id] archived", () => {
  const call = (b: unknown) =>
    PATCH(new Request("http://t/api/projects/p1", { method: "PATCH", body: JSON.stringify(b), headers: { "content-type": "application/json" } }), {
      params: Promise.resolve({ id: "p1" }),
    });
  const old = new Date("2026-01-01T00:00:00Z");

  beforeEach(() => {
    vi.clearAllMocks();
    m(requireCtx).mockResolvedValue(ctx);
    m(requireProject).mockResolvedValue({});
    m(prisma.project.update).mockResolvedValue({ id: "p1" });
  });

  it("archived:true → archivedAt 에 시각", async () => {
    m(prisma.project.findUnique).mockResolvedValue({ id: "p1", workspaceId: "w1", archivedAt: null });
    await call({ archived: true });
    expect(m(prisma.project.update).mock.calls[0][0].data.archivedAt).toBeInstanceOf(Date);
  });

  it("이미 보관된 프로젝트에 다시 true → 원래 시각 유지", async () => {
    m(prisma.project.findUnique).mockResolvedValue({ id: "p1", workspaceId: "w1", archivedAt: old });
    await call({ archived: true });
    expect(m(prisma.project.update).mock.calls[0][0].data.archivedAt).toBe(old);
  });

  it("archived:false → null 로 해제", async () => {
    m(prisma.project.findUnique).mockResolvedValue({ id: "p1", workspaceId: "w1", archivedAt: old });
    await call({ archived: false });
    expect(m(prisma.project.update).mock.calls[0][0].data.archivedAt).toBeNull();
  });

  it("archived 를 안 보내면 archivedAt 을 건드리지 않는다", async () => {
    m(prisma.project.findUnique).mockResolvedValue({ id: "p1", workspaceId: "w1", archivedAt: old });
    await call({ name: "새 이름" });
    expect(m(prisma.project.update).mock.calls[0][0].data).not.toHaveProperty("archivedAt");
  });

  it("잠긴 프로젝트는 게이트가 막는다", async () => {
    m(requireProject).mockResolvedValue({ err: new Response(null, { status: 403 }) });
    const res = await call({ archived: true });
    expect(res.status).toBe(403);
    expect(m(prisma.project.update)).not.toHaveBeenCalled();
  });
});
