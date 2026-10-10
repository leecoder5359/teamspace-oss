import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    approval: { findUnique: vi.fn(), update: vi.fn() },
    notification: { updateMany: vi.fn() },
  },
}));
vi.mock("@/lib/slack", () => ({ getSlackConfig: vi.fn(async () => null) }));

import { prisma } from "@/lib/prisma";
import { recordDecision, applyDecision } from "./approvals";

const m = (f: unknown) => f as Mock;
const decided = { id: "ap1", workspaceId: "w1", status: "approved", slackChannel: null, slackTs: null, title: "t", body: "", kind: "general", responseText: null, respondedBy: "u1", respondedAt: new Date() };

describe("승인 결정 → 승인 요청 알림 읽음 (B3)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(prisma.approval.findUnique).mockResolvedValue({ status: "pending" });
    m(prisma.approval.update).mockResolvedValue(decided);
    m(prisma.notification.updateMany).mockResolvedValue({ count: 3 });
  });

  it("recordDecision(슬랙 경로) 성공 시 같은 approvalId 링크의 미읽음 승인 알림을 읽음 처리한다", async () => {
    await recordDecision("ap1", { status: "approved", userId: "u1" });
    expect(prisma.notification.updateMany).toHaveBeenCalledTimes(1);
    const arg = m(prisma.notification.updateMany).mock.calls[0][0];
    expect(arg.where).toEqual({ workspaceId: "w1", type: "approval", readAt: null, link: { contains: "ap1" } });
    expect(arg.data.readAt).toBeInstanceOf(Date);
  });

  it("applyDecision(앱 경로)도 알림을 읽음 처리한다", async () => {
    await applyDecision("ap1", { status: "rejected", responseText: "no" });
    expect(prisma.notification.updateMany).toHaveBeenCalledTimes(1);
  });

  it("이미 결정된 승인이면(기록 실패) 알림은 건드리지 않는다", async () => {
    m(prisma.approval.findUnique).mockResolvedValue({ status: "approved" });
    await expect(recordDecision("ap1", { status: "rejected" })).rejects.toThrow("already_decided:approved");
    expect(prisma.notification.updateMany).not.toHaveBeenCalled();
  });

  it("승인이 없으면 알림은 건드리지 않는다", async () => {
    m(prisma.approval.findUnique).mockResolvedValue(null);
    await expect(recordDecision("ap1", { status: "approved" })).rejects.toThrow("approval not found");
    expect(prisma.notification.updateMany).not.toHaveBeenCalled();
  });

  it("DB 업데이트가 실패하면 알림은 건드리지 않는다", async () => {
    m(prisma.approval.update).mockRejectedValue(new Error("db down"));
    await expect(recordDecision("ap1", { status: "approved" })).rejects.toThrow("db down");
    expect(prisma.notification.updateMany).not.toHaveBeenCalled();
  });

  it("알림 읽음 처리가 실패해도 결정 기록은 성공으로 돌아온다(베스트에포트)", async () => {
    m(prisma.notification.updateMany).mockRejectedValue(new Error("boom"));
    await expect(recordDecision("ap1", { status: "approved" })).resolves.toEqual(decided);
  });
});
