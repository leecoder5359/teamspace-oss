import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: { notification: { updateMany: vi.fn() } } }));

import { prisma } from "@/lib/prisma";
import { autoReadStaleApprovalNotifications, maybeAutoReadStaleApprovals, parseNotifTypes, unknownNotifTypes, __resetStaleApprovalGuard } from "./notificationsCleanup";

const m = (f: unknown) => f as Mock;

describe("autoReadStaleApprovalNotifications", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(prisma.notification.updateMany).mockResolvedValue({ count: 7 });
  });

  it("기본 14일보다 오래된 미읽음 승인 알림을 now 로 읽음 처리하고 건수를 돌려준다", async () => {
    const now = new Date("2026-10-09T00:00:00Z");
    const n = await autoReadStaleApprovalNotifications("w1", undefined, now);
    expect(n).toBe(7);
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: "w1", type: "approval", readAt: null, createdAt: { lt: new Date("2026-09-25T00:00:00Z") } },
      data: { readAt: now },
    });
  });

  it("olderThanDays 를 받는다", async () => {
    const now = new Date("2026-10-09T00:00:00Z");
    await autoReadStaleApprovalNotifications("w1", 1, now);
    expect(m(prisma.notification.updateMany).mock.calls[0][0].where.createdAt).toEqual({ lt: new Date("2026-10-08T00:00:00Z") });
  });
});

describe("maybeAutoReadStaleApprovals — 워크스페이스별 하루 1회", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    __resetStaleApprovalGuard();
    m(prisma.notification.updateMany).mockResolvedValue({ count: 0 });
  });

  it("같은 워크스페이스는 24시간 안에 한 번만, 다른 워크스페이스는 따로", async () => {
    const t0 = new Date("2026-10-09T00:00:00Z");
    await maybeAutoReadStaleApprovals("w1", t0);
    await maybeAutoReadStaleApprovals("w1", new Date("2026-10-09T23:00:00Z"));
    expect(prisma.notification.updateMany).toHaveBeenCalledTimes(1);
    await maybeAutoReadStaleApprovals("w2", t0);
    expect(prisma.notification.updateMany).toHaveBeenCalledTimes(2);
    await maybeAutoReadStaleApprovals("w1", new Date("2026-10-10T00:00:01Z"));
    expect(prisma.notification.updateMany).toHaveBeenCalledTimes(3);
  });

  it("실패해도 던지지 않는다", async () => {
    m(prisma.notification.updateMany).mockRejectedValue(new Error("boom"));
    await expect(maybeAutoReadStaleApprovals("w1")).resolves.toBeUndefined();
  });
});

describe("parseNotifTypes", () => {
  it("콤마 복수·공백·중복·모르는 값", () => {
    expect(parseNotifTypes("approval, mention,approval,bogus")).toEqual(["approval", "mention"]);
    expect(parseNotifTypes(null)).toEqual([]);
    expect(parseNotifTypes("bogus")).toEqual([]);
    expect(parseNotifTypes("proposal,shared")).toEqual(["proposal", "shared"]);
    // 문서 코멘트 알림은 mention 으로 쌓인다 — comment 종류는 생산자가 없다
    expect(parseNotifTypes("comment")).toEqual([]);
  });
  it("unknownNotifTypes — 모르는 값만, 빈 조각은 무시", () => {
    expect(unknownNotifTypes("approval,comment, bogus,,")).toEqual(["comment", "bogus"]);
    expect(unknownNotifTypes(null)).toEqual([]);
    expect(unknownNotifTypes("proposal,shared")).toEqual([]);
  });
});
