import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    publishedSite: { findFirst: vi.fn() },
    siteInvite: { createMany: vi.fn(), deleteMany: vi.fn() },
  },
}));
import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { POST, DELETE } from "./route";

const m = (f: unknown) => f as Mock;
const ctx = { workspaceId: "w1", userId: "u1", role: "editor", actor: { type: "user", id: "u1", name: "U" } };
const params = { params: Promise.resolve({ id: "cs1" }) };
const req = (method: string, body: unknown) => new Request("http://t/api/sites/cs1/invites", { method, body: JSON.stringify(body) });

describe("/api/sites/[id]/invites", () => {
  beforeEach(() => vi.resetAllMocks());

  it("남의 워크스페이스 사이트는 404", async () => {
    m(requireCtx).mockResolvedValue(ctx);
    m(prisma.publishedSite.findFirst).mockResolvedValue(null);
    expect((await POST(req("POST", { emails: ["a@x.com"] }), params)).status).toBe(404);
    expect(m(prisma.publishedSite.findFirst).mock.calls[0][0]).toMatchObject({ where: { id: "cs1", workspaceId: "w1", deletedAt: null } });
  });

  it("추가: 정규화·중복 무시·형식 불량 보고", async () => {
    m(requireCtx).mockResolvedValue(ctx);
    m(prisma.publishedSite.findFirst).mockResolvedValue({ id: "cs1", title: "T" });
    const res = await POST(req("POST", { emails: ["A@x.com", "a@x.com", "bad"] }), params);
    expect(await res.json()).toEqual({ added: ["a@x.com"], invalid: ["bad"] });
    expect(prisma.siteInvite.createMany).toHaveBeenCalledWith({ data: [{ siteId: "cs1", email: "a@x.com", createdById: "u1" }], skipDuplicates: true });
  });

  it("emails 가 배열이 아니면 400", async () => {
    m(requireCtx).mockResolvedValue(ctx);
    m(prisma.publishedSite.findFirst).mockResolvedValue({ id: "cs1", title: "T" });
    expect((await POST(req("POST", { emails: "a@x.com" }), params)).status).toBe(400);
  });

  it("제거: 정규화한 이메일로 deleteMany", async () => {
    m(requireCtx).mockResolvedValue(ctx);
    m(prisma.publishedSite.findFirst).mockResolvedValue({ id: "cs1", title: "T" });
    m(prisma.siteInvite.deleteMany).mockResolvedValue({ count: 1 });
    const res = await DELETE(req("DELETE", { emails: ["A@x.com"] }), params);
    expect(await res.json()).toEqual({ removed: 1 });
    expect(prisma.siteInvite.deleteMany).toHaveBeenCalledWith({ where: { siteId: "cs1", email: { in: ["a@x.com"] } } });
  });
});
