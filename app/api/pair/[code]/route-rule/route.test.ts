import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {
  pairing: { findUnique: vi.fn() },
  project: { findUnique: vi.fn() },
  workspaceRouteRule: { findFirst: vi.fn(), create: vi.fn() },
} }));
import { prisma } from "@/lib/prisma";
import { POST } from "./route";
const ctx = (code: string) => ({ params: Promise.resolve({ code }) });
const body = (b: unknown) => new Request("http://t", { method: "POST", body: JSON.stringify(b) });
beforeEach(() => vi.resetAllMocks());
const live = { code: "c", workspaceId: "w", createdAt: new Date(), token: "wst_x", userId: "u", tokenDeliveredAt: null };

describe("POST /api/pair/[code]/route-rule", () => {
  it("코드 형식이 아니면 DB 조회 없이 400", async () => {
    const res = await POST(body({ cwd: "/Users/mac/dev/x" }), ctx("bad"));
    expect(res.status).toBe(400);
    expect(prisma.pairing.findUnique).not.toHaveBeenCalled();
  });
  it("부재 페어링 → 410 + '찾을 수 없습니다' 메시지", async () => {
    (prisma.pairing.findUnique as unknown as Mock).mockResolvedValue(null);
    const res = await POST(body({ cwd: "/Users/mac/dev/x", projectId: "p" }), ctx("a".repeat(32)));
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("찾을 수 없") });
  });
  it("실제 만료 row(createdAt 이 TTL 초과) → 410 + '만료' 메시지", async () => {
    const expiredRow = { ...live, createdAt: new Date(Date.now() - 700_000) };
    (prisma.pairing.findUnique as unknown as Mock).mockResolvedValue(expiredRow);
    const res = await POST(body({ cwd: "/Users/mac/dev/x", projectId: "p" }), ctx("c".repeat(32)));
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("만료") });
  });
  it("상대경로 cwd → 400", async () => {
    (prisma.pairing.findUnique as unknown as Mock).mockResolvedValue(live);
    const res = await POST(body({ cwd: "relative", projectId: "p" }), ctx("c".repeat(32)));
    expect(res.status).toBe(400);
  });
  it("프로젝트가 다른 워크스페이스 소속 → 400", async () => {
    (prisma.pairing.findUnique as unknown as Mock).mockResolvedValue(live);
    (prisma.project.findUnique as unknown as Mock).mockResolvedValue({ workspaceId: "OTHER" });
    const res = await POST(body({ cwd: "/Users/mac/dev/x", projectId: "p" }), ctx("c".repeat(32)));
    expect(res.status).toBe(400);
  });
  it("정상 → create 호출 + 200 (workspaceId 스코프로 조회/생성)", async () => {
    (prisma.pairing.findUnique as unknown as Mock).mockResolvedValue(live);
    (prisma.project.findUnique as unknown as Mock).mockResolvedValue({ workspaceId: "w" });
    (prisma.workspaceRouteRule.findFirst as unknown as Mock).mockResolvedValue(null);
    (prisma.workspaceRouteRule.create as unknown as Mock).mockResolvedValue({ id: "r" });
    const res = await POST(body({ cwd: "/Users/mac/dev/x", projectId: "p" }), ctx("c".repeat(32)));
    expect(res.status).toBe(200);
    expect(prisma.workspaceRouteRule.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: "w", cwdPrefix: "/Users/mac/dev/x" }) })
    );
    expect(prisma.workspaceRouteRule.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ workspaceId: "w", cwdPrefix: "/Users/mac/dev/x" }),
      })
    );
  });
  it("중복 cwd → deduped, create 미호출", async () => {
    (prisma.pairing.findUnique as unknown as Mock).mockResolvedValue(live);
    (prisma.project.findUnique as unknown as Mock).mockResolvedValue({ workspaceId: "w" });
    (prisma.workspaceRouteRule.findFirst as unknown as Mock).mockResolvedValue({ id: "existing" });
    const res = await POST(body({ cwd: "/Users/mac/dev/x", projectId: "p" }), ctx("c".repeat(32)));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deduped: true });
    expect(prisma.workspaceRouteRule.create).not.toHaveBeenCalled();
  });
});
