import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    publishedSite: { findFirst: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
    siteSlugAlias: { findUnique: vi.fn(), deleteMany: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
    siteVersion: { findUnique: vi.fn() },
    project: { findFirst: vi.fn() },
  },
}));
import { requireCtx } from "@/lib/workspace";
import { recordActivity } from "@/lib/activity";
import { prisma } from "@/lib/prisma";
import { PATCH } from "./route";
import { SITE_SLUG_LOCK_KEY } from "@/lib/sites/slug";

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

describe("PATCH /api/sites/[id] — slug", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue(ctx);
    m(prisma.publishedSite.findFirst).mockResolvedValue({ id: "cs1", slug: "OLDrandom123", title: "T", status: "active", currentVersion: 1, apiUpstream: null });
    m(prisma.$transaction).mockImplementation(async (fn: (t: unknown) => unknown) => fn(prisma));
    m(prisma.publishedSite.update).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "cs1", title: "T", slug: "banjang-handover", ...data }));
  });

  it("바꾸면 옛 슬러그를 별칭으로 남기고 새 url 을 돌려준다", async () => {
    const res = await PATCH(patch({ slug: "banjang-handover" }), params);
    expect(res.status).toBe(200);
    expect(prisma.publishedSite.update).toHaveBeenCalledWith({ where: { id: "cs1" }, data: { slug: "banjang-handover" } });
    expect(prisma.siteSlugAlias.create).toHaveBeenCalledWith({ data: { slug: "OLDrandom123", siteId: "cs1" } });
    const body = await res.json();
    expect(body.url).toMatch(/\/s\/banjang-handover$/);
    expect(recordActivity).toHaveBeenCalledWith(ctx, "주소를 /s/banjang-handover 로 바꿈", "site", "T", "cs1");
  });

  it("변경은 트랜잭션 안에서 advisory 락을 먼저 잡고 검사·쓰기", async () => {
    let inTx = false;
    m(prisma.$transaction).mockImplementation(async (fn: (t: unknown) => unknown) => { inTx = true; try { return await fn(prisma); } finally { inTx = false; } });
    let lockedInTx = false;
    m(prisma.$executeRaw).mockImplementation(async () => { lockedInTx = inTx; return 0; });
    expect((await PATCH(patch({ slug: "locked-name" }), params)).status).toBe(200);
    expect(lockedInTx).toBe(true);
    const call = m(prisma.$executeRaw).mock.calls[0];
    expect(call[0].join("?")).toContain("pg_advisory_xact_lock");
    expect(call[1]).toBe(SITE_SLUG_LOCK_KEY);
    const order = (f: unknown) => m(f).mock.invocationCallOrder[0];
    expect(order(prisma.$executeRaw)).toBeLessThan(order(prisma.siteSlugAlias.findUnique));
    expect(order(prisma.$executeRaw)).toBeLessThan(order(prisma.publishedSite.update));
  });

  it("형식이 틀리면 400, 쓰기 없음", async () => {
    for (const bad of ["UPPER", "ab", "admin", 7, "a--b"]) {
      expect((await PATCH(patch({ slug: bad }), params)).status, String(bad)).toBe(400);
    }
    expect(prisma.publishedSite.update).not.toHaveBeenCalled();
  });

  it("다른 사이트의 주소·옛 주소면 409", async () => {
    m(prisma.siteSlugAlias.findUnique).mockResolvedValue({ siteId: "other" });
    const res = await PATCH(patch({ slug: "someone-else" }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("이미 쓰고 있는 주소");
    expect(prisma.siteSlugAlias.create).not.toHaveBeenCalled();
  });

  it("자기 옛 주소로 되돌리면 그 별칭을 지우고 지금 주소를 별칭으로", async () => {
    m(prisma.siteSlugAlias.findUnique).mockResolvedValue({ siteId: "cs1" });
    const res = await PATCH(patch({ slug: "earlier-name" }), params);
    expect(res.status).toBe(200);
    expect(prisma.siteSlugAlias.deleteMany).toHaveBeenCalledWith({ where: { slug: "earlier-name", siteId: "cs1" } });
    expect(prisma.siteSlugAlias.create).toHaveBeenCalledWith({ data: { slug: "OLDrandom123", siteId: "cs1" } });
  });

  it("같은 슬러그면 트랜잭션·별칭 없이 그대로", async () => {
    m(prisma.publishedSite.findFirst).mockResolvedValue({ id: "cs1", slug: "same-name", title: "T", status: "active", currentVersion: 1, apiUpstream: null });
    const res = await PATCH(patch({ slug: "same-name" }), params);
    expect(res.status).toBe(200);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.siteSlugAlias.create).not.toHaveBeenCalled();
  });
});
