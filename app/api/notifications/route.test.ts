import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { notification: { findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn(), updateMany: vi.fn() } },
}));
vi.mock("@/lib/notificationsCleanup", async (orig) => ({
  ...(await orig<typeof import("@/lib/notificationsCleanup")>()),
  maybeAutoReadStaleApprovals: vi.fn(async () => {}),
}));

import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { maybeAutoReadStaleApprovals } from "@/lib/notificationsCleanup";
import { GET, POST } from "./route";

const m = (f: unknown) => f as Mock;
const get = (qs = "") => GET(new Request(`http://t/api/notifications${qs}`));

describe("GET /api/notifications — 종류 필터·byType", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "member" });
    m(prisma.notification.findMany).mockResolvedValue([]);
    m(prisma.notification.count).mockResolvedValue(5);
    m(prisma.notification.groupBy).mockResolvedValue([
      { type: "approval", _count: { _all: 3 } },
      { type: "assigned", _count: { _all: 2 } },
    ]);
  });

  it("?type= 없으면 종류 조건 없이 조회", async () => {
    await get();
    expect(m(prisma.notification.findMany).mock.calls[0][0].where).toEqual({ workspaceId: "w1", userId: "u1" });
  });

  it("?type=approval 단일 필터", async () => {
    await get("?type=approval");
    expect(m(prisma.notification.findMany).mock.calls[0][0].where.type).toEqual({ in: ["approval"] });
  });

  it("?type=approval,mention 콤마 복수·공백 허용", async () => {
    await get("?type=approval,%20mention");
    expect(m(prisma.notification.findMany).mock.calls[0][0].where.type).toEqual({ in: ["approval", "mention"] });
  });

  it("?type=proposal,shared — 제안·공유 알림도 필터된다", async () => {
    await get("?type=proposal,shared");
    expect(m(prisma.notification.findMany).mock.calls[0][0].where.type).toEqual({ in: ["proposal", "shared"] });
  });

  it("모르는 종류가 섞이면 400(필터 없는 전체를 필터된 척 내보내지 않는다)", async () => {
    for (const qs of ["?type=bogus", "?type=approval,comment"]) {
      const r = await get(qs);
      expect(r.status).toBe(400);
      expect((await r.json()).error).toContain("가능: approval, assigned, mention, due, proposal, shared");
    }
    expect(prisma.notification.findMany).not.toHaveBeenCalled();
  });

  it("빈 ?type= 은 필터 없음", async () => {
    const r = await get("?type=");
    expect(r.status).toBe(200);
    expect(m(prisma.notification.findMany).mock.calls[0][0].where.type).toBeUndefined();
  });

  it("unread 집계는 필터와 무관하게 전체 미읽음", async () => {
    const body = await (await get("?type=approval")).json();
    expect(body.unread).toBe(5);
    expect(m(prisma.notification.count).mock.calls[0][0].where).toEqual({ workspaceId: "w1", userId: "u1", readAt: null });
  });

  it("byType = 미읽음 종류별 건수", async () => {
    const body = await (await get("?type=mention")).json();
    expect(body.byType).toEqual({ approval: 3, assigned: 2 });
    const gb = m(prisma.notification.groupBy).mock.calls[0][0];
    expect(gb.by).toEqual(["type"]);
    expect(gb.where).toEqual({ workspaceId: "w1", userId: "u1", readAt: null });
  });

  it("조회 때마다 워크스페이스로 오래된 승인 알림 정리를 부른다(하루 1회 가드는 lib 쪽)", async () => {
    await get();
    expect(maybeAutoReadStaleApprovals).toHaveBeenCalledWith("w1");
  });
});

describe("GET ?group=1 · POST ids", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "member" });
    m(prisma.notification.count).mockResolvedValue(2);
    m(prisma.notification.groupBy).mockResolvedValue([]);
  });

  it("group=1 은 groups 를 돌려주고 같은 필터·limit 를 쓴다", async () => {
    const t = new Date();
    m(prisma.notification.findMany).mockResolvedValue([
      { id: "a", type: "mention", title: "A", link: "/x", readAt: null, createdAt: t },
      { id: "b", type: "mention", title: "B", link: "/x", readAt: t, createdAt: t },
    ]);
    const body = await (await get("?group=1&unread=1&limit=500&type=mention")).json();
    expect(body.notifications).toBeUndefined();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]).toMatchObject({ count: 2, unread: 1, ids: expect.arrayContaining(["a", "b"]) });
    const args = m(prisma.notification.findMany).mock.calls[0][0];
    expect(args.take).toBe(200);
    expect(args.where).toMatchObject({ readAt: null, type: { in: ["mention"] } });
  });

  it("POST ids 는 본인 알림 범위로만 읽음 처리", async () => {
    m(prisma.notification.updateMany).mockResolvedValue({ count: 2 });
    const r = await POST(new Request("http://t/api/notifications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: ["a", "b"] }) }));
    expect((await r.json()).read).toBe(2);
    expect(m(prisma.notification.updateMany).mock.calls[0][0].where).toEqual({ id: { in: ["a", "b"] }, workspaceId: "w1", userId: "u1", readAt: null });
  });
});
