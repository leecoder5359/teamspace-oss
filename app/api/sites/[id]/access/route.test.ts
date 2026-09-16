import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { publishedSite: { findFirst: vi.fn() }, siteAccess: { findMany: vi.fn() } },
}));
import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { GET } from "./route";

const m = (f: unknown) => f as Mock;
const params = { params: Promise.resolve({ id: "cs1" }) };

describe("GET /api/sites/[id]/access", () => {
  beforeEach(() => vi.resetAllMocks());

  it("인증 실패는 그대로", async () => {
    m(requireCtx).mockResolvedValue({ err: new Response(null, { status: 401 }) });
    expect((await GET(new Request("http://t"), params)).status).toBe(401);
  });

  it("남의 워크스페이스 사이트는 404", async () => {
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "viewer" });
    m(prisma.publishedSite.findFirst).mockResolvedValue(null);
    expect((await GET(new Request("http://t"), params)).status).toBe(404);
    expect(m(prisma.publishedSite.findFirst).mock.calls[0][0]).toMatchObject({ where: { id: "cs1", workspaceId: "w1", deletedAt: null } });
  });

  it("계정별 요약을 돌려준다", async () => {
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "viewer" });
    m(prisma.publishedSite.findFirst).mockResolvedValue({ id: "cs1", invites: [{ email: "g@gmail.com" }] });
    m(prisma.siteAccess.findMany).mockResolvedValue([
      { email: "g@gmail.com", member: false, version: 1, createdAt: new Date("2026-09-15T01:00:00Z") },
    ]);
    const body = await (await GET(new Request("http://t"), params)).json();
    expect(body.total).toBe(1);
    expect(body.accounts[0]).toMatchObject({ email: "g@gmail.com", kind: "invited", count: 1 });
  });
});
