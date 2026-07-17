import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  project: { findUnique: vi.fn() },
  workspaceRouteRule: { create: vi.fn(), findMany: vi.fn() },
} }));
import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { POST, GET } from "./route";

const body = (b: unknown) => new Request("http://t/api/route-rules", { method: "POST", body: JSON.stringify(b) });
beforeEach(() => vi.resetAllMocks());

describe("GET /api/route-rules", () => {
  it("컨텍스트 없으면 err 그대로 반환", async () => {
    (requireCtx as unknown as Mock).mockResolvedValue({ err: new Response(null, { status: 401 }) });
    const res = await GET();
    expect(res.status).toBe(401);
  });
});

describe("POST /api/route-rules", () => {
  it("editor 권한으로 route-rule 추가 가능(admin 아님)", async () => {
    (requireCtx as unknown as Mock).mockResolvedValue({ workspaceId: "w", userId: "u", role: "editor" });
    (prisma.project.findUnique as unknown as Mock).mockResolvedValue({ workspaceId: "w" });
    (prisma.workspaceRouteRule.create as unknown as Mock).mockResolvedValue({ id: "r" });
    const res = await POST(body({ cwdPrefix: "/Users/mac/dev/x", projectId: "p" }));
    expect(res.status).toBe(200);
    // 게이트가 editor 로 완화됐는지: requireCtx 가 "editor" 로 호출됨
    expect(requireCtx).toHaveBeenCalledWith("editor");
  });

  it("상대경로 cwdPrefix → 400", async () => {
    (requireCtx as unknown as Mock).mockResolvedValue({ workspaceId: "w", userId: "u", role: "editor" });
    const res = await POST(body({ cwdPrefix: "relative", projectId: "p" }));
    expect(res.status).toBe(400);
  });

  it("프로젝트가 다른 워크스페이스 소속 → 400", async () => {
    (requireCtx as unknown as Mock).mockResolvedValue({ workspaceId: "w", userId: "u", role: "editor" });
    (prisma.project.findUnique as unknown as Mock).mockResolvedValue({ workspaceId: "OTHER" });
    const res = await POST(body({ cwdPrefix: "/Users/mac/dev/x", projectId: "p" }));
    expect(res.status).toBe(400);
  });

  it("권한 부족(viewer 등) → requireCtx 의 err 그대로 반환", async () => {
    (requireCtx as unknown as Mock).mockResolvedValue({ err: new Response(null, { status: 403 }) });
    const res = await POST(body({ cwdPrefix: "/Users/mac/dev/x" }));
    expect(res.status).toBe(403);
  });
});
