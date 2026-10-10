import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    workspace: { findMany: vi.fn() },
    workspaceMember: { findMany: vi.fn() },
    notifLog: { findFirst: vi.fn(), create: vi.fn(), delete: vi.fn() },
  },
}));
vi.mock("@/lib/activity", () => ({ pushNotification: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { prisma } from "@/lib/prisma";
import { pushNotification } from "@/lib/activity";
import { REHEARSAL_REMINDER_TITLE, rehearsalMarkerRef, sendRehearsalReminders } from "./rehearsalReminder";

const m = (f: unknown) => f as Mock;
const firstMonday = new Date(2026, 9, 5, 9, 0); // 2026-10-05 월
const admin = (userId: string, email: string) => ({ userId, user: { email } });

beforeEach(() => {
  vi.clearAllMocks();
  m(prisma.workspace.findMany).mockResolvedValue([{ id: "w1" }]);
  m(prisma.notifLog.findFirst).mockResolvedValue(null);
  m(prisma.notifLog.create).mockResolvedValue({ id: "mk1" });
  m(prisma.notifLog.delete).mockResolvedValue({});
  m(prisma.workspaceMember.findMany).mockResolvedValue([admin("u1", "a@x.com"), admin("bot", "b@agents.teamspace.local")]);
});

describe("sendRehearsalReminders", () => {
  it("분기 첫 월요일이 아니면 아무것도 하지 않는다", async () => {
    const r = await sendRehearsalReminders(new Date(2026, 9, 12, 9, 0));
    expect(r).toEqual({ quarter: null, notified: 0, skipped: 0, failed: 0 });
    expect(prisma.workspace.findMany).not.toHaveBeenCalled();
  });

  it("사람 관리자에게 due 알림(/settings)을 보내고 분기 마커를 남긴다", async () => {
    const r = await sendRehearsalReminders(firstMonday);
    expect(r).toEqual({ quarter: "2026-Q4", notified: 1, skipped: 0, failed: 0 });
    expect(prisma.workspaceMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "w1", role: "admin", status: "active" } }),
    );
    expect(pushNotification).toHaveBeenCalledWith("w1", ["u1"], "due", REHEARSAL_REMINDER_TITLE, "/settings");
    expect(REHEARSAL_REMINDER_TITLE.startsWith("분기 복원 리허설")).toBe(true);
    expect(prisma.notifLog.create).toHaveBeenCalledWith({
      data: { workspaceId: "w1", channel: "-", text: rehearsalMarkerRef("2026-Q4"), kind: "rehearsal_marker", state: "sent" },
      select: { id: true },
    });
  });

  it("09:00~09:59 창 밖(10시)이면 첫 월요일이어도 하지 않는다", async () => {
    const r = await sendRehearsalReminders(new Date(2026, 9, 5, 10, 0));
    expect(r.quarter).toBeNull();
    expect(prisma.workspace.findMany).not.toHaveBeenCalled();
  });

  it("마커를 알림보다 먼저 쓴다 — 마커 쓰기 실패 시 알림도 없다", async () => {
    const order: string[] = [];
    m(prisma.notifLog.create).mockImplementation(async () => {
      order.push("marker");
      return { id: "mk1" };
    });
    m(pushNotification).mockImplementation(async () => {
      order.push("push");
    });
    await sendRehearsalReminders(firstMonday);
    expect(order).toEqual(["marker", "push"]);

    vi.clearAllMocks();
    m(prisma.workspace.findMany).mockResolvedValue([{ id: "w1" }]);
    m(prisma.notifLog.findFirst).mockResolvedValue(null);
    m(prisma.workspaceMember.findMany).mockResolvedValue([admin("u1", "a@x.com")]);
    m(prisma.notifLog.create).mockRejectedValue(new Error("db"));
    const r = await sendRehearsalReminders(firstMonday);
    expect(pushNotification).not.toHaveBeenCalled();
    expect(r).toMatchObject({ notified: 0, failed: 1 });
  });

  it("알림이 실패하면 마커를 거두고 failed 로 알린다(창 안 재시도)", async () => {
    m(pushNotification).mockRejectedValueOnce(new Error("push"));
    const r = await sendRehearsalReminders(firstMonday);
    expect(prisma.notifLog.delete).toHaveBeenCalledWith({ where: { id: "mk1" } });
    expect(r).toMatchObject({ notified: 0, failed: 1 });
  });

  it("마커가 있으면(같은 분기 이미 보냄) 건너뛴다 — 매분 tick·재기동에도 1회", async () => {
    m(prisma.notifLog.findFirst).mockResolvedValue({ id: "n1" });
    const r = await sendRehearsalReminders(firstMonday);
    expect(r).toEqual({ quarter: "2026-Q4", notified: 0, skipped: 1, failed: 0 });
    expect(pushNotification).not.toHaveBeenCalled();
    expect(prisma.notifLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: "w1", kind: "rehearsal_marker", text: "rehearsal:2026-Q4" }) }),
    );
  });

  it("사람 관리자가 없으면 보내지도 마커를 남기지도 않는다", async () => {
    m(prisma.workspaceMember.findMany).mockResolvedValue([admin("bot", "b@agents.teamspace.local")]);
    const r = await sendRehearsalReminders(firstMonday);
    expect(r.notified).toBe(0);
    expect(pushNotification).not.toHaveBeenCalled();
    expect(prisma.notifLog.create).not.toHaveBeenCalled();
  });

  it("한 워크스페이스의 실패가 다음 워크스페이스를 막지 않는다", async () => {
    m(prisma.workspace.findMany).mockResolvedValue([{ id: "w1" }, { id: "w2" }]);
    m(prisma.notifLog.findFirst).mockImplementationOnce(async () => {
      throw new Error("db");
    });
    const r = await sendRehearsalReminders(firstMonday);
    expect(r.notified).toBe(1);
    expect(pushNotification).toHaveBeenCalledWith("w2", ["u1"], "due", REHEARSAL_REMINDER_TITLE, "/settings");
  });
});
