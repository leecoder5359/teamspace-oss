import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { notification: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() } } }));

import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { GET } from "./route";

const m = (f: unknown) => f as Mock;
const now = Date.now();
const row = (id: string, type: string, link: string, agoH: number, read = false) => ({
  id, type, title: id, link, readAt: read ? new Date() : null, createdAt: new Date(now - agoH * 3600_000),
});

describe("GET /api/notifications/digest", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "viewer" });
  });

  it("본인 알림만, hours 창으로 조회하고 집계는 DB count·groupBy 로", async () => {
    m(prisma.notification.findMany).mockResolvedValue([
      row("a", "mention", "/x", 1), row("b", "mention", "/x", 2, true), row("c", "due", "/y", 3),
    ]);
    // 1000건 상한을 넘는 경우 — 집계는 findMany 결과가 아니라 count/groupBy 값을 쓴다
    m(prisma.notification.count).mockImplementation(async (args: { where: { readAt?: null } }) => ("readAt" in args.where ? 1200 : 1500));
    m(prisma.notification.groupBy).mockResolvedValue([
      { type: "mention", _count: { _all: 1400 } },
      { type: "due", _count: { _all: 100 } },
    ]);
    const r = await GET(new Request("http://t/api/notifications/digest?hours=6"));
    const body = await r.json();
    const where = m(prisma.notification.findMany).mock.calls[0][0].where;
    expect(where.workspaceId).toBe("w1");
    expect(where.userId).toBe("u1");
    expect(m(prisma.notification.count).mock.calls.map((c) => c[0].where)).toContainEqual({ ...where, readAt: null });
    expect(m(prisma.notification.groupBy).mock.calls[0][0]).toMatchObject({ by: ["type"], where });
    expect(new Date(body.until).getTime() - new Date(body.since).getTime()).toBe(6 * 3600_000);
    expect(body.total).toBe(1500);
    expect(body.unread).toBe(1200);
    expect(body.byType).toEqual({ mention: 1400, due: 100 });
    expect(body.topGroups[0].key).toBe("mention|/x");
  });

  it("topGroups 는 5개까지, 잘못된 hours 는 24로", async () => {
    m(prisma.notification.count).mockResolvedValue(8);
    m(prisma.notification.groupBy).mockResolvedValue([]);
    m(prisma.notification.findMany).mockResolvedValue(Array.from({ length: 8 }, (_, i) => row(`n${i}`, "due", `/p${i}`, 1)));
    const body = await (await GET(new Request("http://t/api/notifications/digest?hours=abc"))).json();
    expect(body.topGroups).toHaveLength(5);
    expect(new Date(body.until).getTime() - new Date(body.since).getTime()).toBe(24 * 3600_000);
  });

  it("인증 실패는 그대로 반환", async () => {
    m(requireCtx).mockResolvedValue({ err: new Response("no", { status: 401 }) });
    expect((await GET(new Request("http://t/api/notifications/digest"))).status).toBe(401);
  });
});
