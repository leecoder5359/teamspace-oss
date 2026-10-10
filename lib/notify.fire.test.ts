import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: { notifRule: { findMany: vi.fn() } } }));
vi.mock("@/lib/slack", () => ({ postMessage: vi.fn() }));
vi.mock("@/lib/activity", () => ({ pushNotification: vi.fn(), userIdsByNames: vi.fn() }));
vi.mock("@/lib/pageGuard", () => ({ isRestrictedPage: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { postMessage } from "@/lib/slack";
import { fireNotif } from "./notify";

const m = (f: unknown) => f as Mock;
const rule = (id: string, targetId: string, projectId: string | null) => ({ id, targetId, projectId });

describe("fireNotif — 규칙 선택·결과·기본 채널 폴백", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m(postMessage).mockResolvedValue({ ok: true });
  });

  it("프로젝트 규칙 채널로만 보내고(전역 제외) text 를 가공하지 않는다", async () => {
    m(prisma.notifRule.findMany).mockResolvedValue([rule("g", "CG", null), rule("p", "CP", "p1")]);
    const text = "📊 *A&amp;B* _(x)_\n• &lt;t&gt;";
    const r = await fireNotif("w1", "weekly_digest", text, "p1", { kind: "digest" });
    expect(r).toEqual({ delivered: 1, failed: 0 });
    expect(m(prisma.notifRule.findMany).mock.calls[0][0].where).toEqual({ workspaceId: "w1", event: "weekly_digest", enabled: true, target: "channel" });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(m(postMessage).mock.calls[0]).toEqual(["w1", { channel: "CP", text, kind: "digest" }]);
  });

  it("프로젝트 규칙이 없으면 전역 규칙, kind 기본값은 notification", async () => {
    m(prisma.notifRule.findMany).mockResolvedValue([rule("g", "CG", null), rule("o", "CO", "other")]);
    await fireNotif("w1", "task_created", "t", "p1");
    expect(m(postMessage).mock.calls[0][1]).toEqual({ channel: "CG", text: "t", kind: "notification" });
  });

  it("규칙이 없으면 폴백 없이는 noTarget, 폴백이면 기본 채널(channel 없이) 발송", async () => {
    m(prisma.notifRule.findMany).mockResolvedValue([]);
    expect(await fireNotif("w1", "doc_saved", "t", "p1")).toEqual({ delivered: 0, failed: 0, noTarget: true });
    expect(postMessage).not.toHaveBeenCalled();
    expect(await fireNotif("w1", "weekly_digest", "t", "p1", { kind: "digest", fallbackToDefault: true })).toEqual({ delivered: 1, failed: 0 });
    expect(m(postMessage).mock.calls[0][1]).toEqual({ text: "t", kind: "digest" });
  });

  it("폴백 대상이 없으면(no_channel·not_connected) noTarget, 다른 슬랙 오류는 failed", async () => {
    m(prisma.notifRule.findMany).mockResolvedValue([]);
    m(postMessage).mockResolvedValue({ ok: false, error: "no_channel" });
    expect(await fireNotif("w1", "weekly_digest", "t", null, { fallbackToDefault: true })).toMatchObject({ delivered: 0, failed: 0, noTarget: true });
    m(postMessage).mockResolvedValue({ ok: false, error: "channel_not_found" });
    expect(await fireNotif("w1", "weekly_digest", "t", null, { fallbackToDefault: true })).toEqual({ delivered: 0, failed: 1, error: "channel_not_found" });
  });

  it("여러 채널 중 일부 실패·throw 는 failed 로 세고, 규칙 조회 실패도 throw 하지 않는다", async () => {
    m(prisma.notifRule.findMany).mockResolvedValue([rule("a", "C1", "p1"), rule("b", "C2", "p1"), rule("c", "C3", "p1")]);
    m(postMessage)
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: "is_archived" })
      .mockRejectedValueOnce(new Error("network"));
    expect(await fireNotif("w1", "weekly_digest", "t", "p1")).toEqual({ delivered: 1, failed: 2, error: "is_archived" });
    m(prisma.notifRule.findMany).mockRejectedValue(new Error("db down"));
    expect(await fireNotif("w1", "weekly_digest", "t", "p1")).toEqual({ delivered: 0, failed: 1, error: "db down" });
  });
});
