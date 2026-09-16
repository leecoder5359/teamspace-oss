import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    publishedSite: { findFirst: vi.fn(), update: vi.fn() },
    siteVersion: { findUnique: vi.fn() },
    project: { findFirst: vi.fn() },
  },
}));
import { requireCtx } from "@/lib/workspace";
import { recordActivity } from "@/lib/activity";
import { prisma } from "@/lib/prisma";
import { PATCH } from "./route";

const m = (f: unknown) => f as Mock;
const ctx = { workspaceId: "w1", userId: "u1", role: "editor", actor: { type: "user", id: "u1", name: "U" } };
const params = { params: Promise.resolve({ id: "cs1" }) };
const patch = (body: unknown) => new Request("http://t/api/sites/cs1", { method: "PATCH", body: JSON.stringify(body) });

describe("PATCH /api/sites/[id] — apiUpstream", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue(ctx);
    m(prisma.publishedSite.findFirst).mockResolvedValue({ id: "cs1", title: "T", status: "active", currentVersion: 1, apiUpstream: null });
    m(prisma.publishedSite.update).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "cs1", title: "T", ...data }));
  });

  it("루프백 주소를 정규화해 저장하고 활동을 남긴다", async () => {
    const res = await PATCH(patch({ apiUpstream: "http://LOCALHOST:4717/" }), params);
    expect(res.status).toBe(200);
    expect(m(prisma.publishedSite.update).mock.calls[0][0].data).toEqual({ apiUpstream: "http://localhost:4717" });
    expect((await res.json()).site.apiUpstream).toBe("http://localhost:4717");
    expect(recordActivity).toHaveBeenCalledWith(ctx, "API 프록시를 연결함", "site", "T", "cs1");
  });

  it("null 은 해제", async () => {
    m(prisma.publishedSite.findFirst).mockResolvedValue({ id: "cs1", title: "T", status: "active", currentVersion: 1, apiUpstream: "http://127.0.0.1:1" });
    const res = await PATCH(patch({ apiUpstream: null }), params);
    expect(res.status).toBe(200);
    expect(m(prisma.publishedSite.update).mock.calls[0][0].data).toEqual({ apiUpstream: null });
    expect(recordActivity).toHaveBeenCalledWith(ctx, "API 프록시를 해제함", "site", "T", "cs1");
  });

  it("루프백이 아니면 400, 저장 안 함", async () => {
    for (const bad of ["http://10.0.0.1:80", "http://127.0.0.1:4717/api", "http://169.254.169.254:80", 4717]) {
      const res = await PATCH(patch({ apiUpstream: bad }), params);
      expect(res.status, String(bad)).toBe(400);
    }
    expect(prisma.publishedSite.update).not.toHaveBeenCalled();
  });

  it("권한 게이트는 editor", async () => {
    m(requireCtx).mockResolvedValue({ err: new Response(null, { status: 403 }) });
    expect((await PATCH(patch({ apiUpstream: "http://127.0.0.1:1" }), params)).status).toBe(403);
    expect(requireCtx).toHaveBeenCalledWith("editor");
  });
});
