import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    publishedSite: { findUnique: vi.fn() },
    siteInvite: { findUnique: vi.fn() },
    workspaceMember: { findFirst: vi.fn() },
    siteAccess: { findFirst: vi.fn(), create: vi.fn() },
  },
}));
import { prisma } from "@/lib/prisma";
import { siteAccessBySlug, siteAccessById, recordSiteAccess } from "./server";

const m = (f: unknown) => f as Mock;
const site = { id: "s1", slug: "abc", title: "T", workspaceId: "w1", currentVersion: 2, status: "active", deletedAt: null };

describe("siteAccess*", () => {
  beforeEach(() => vi.resetAllMocks());

  it("초대받은 게스트 → ok + inviteId", async () => {
    m(prisma.publishedSite.findUnique).mockResolvedValue(site);
    m(prisma.siteInvite.findUnique).mockResolvedValue({ id: "i1" });
    m(prisma.workspaceMember.findFirst).mockResolvedValue(null);
    expect(await siteAccessBySlug("abc", "G@gmail.com")).toEqual({ result: "ok", site, inviteId: "i1", member: false });
    expect(m(prisma.siteInvite.findUnique).mock.calls[0][0]).toMatchObject({
      where: { siteId_email: { siteId: "s1", email: "g@gmail.com" } },
    });
  });

  it("없는 사이트 → not_found, DB 추가 조회 없음", async () => {
    m(prisma.publishedSite.findUnique).mockResolvedValue(null);
    expect(await siteAccessById("nope", "g@gmail.com")).toEqual({ result: "not_found", site: null, inviteId: null, member: false });
    expect(prisma.siteInvite.findUnique).not.toHaveBeenCalled();
  });

  it("초대 회수된 게스트 → forbidden", async () => {
    m(prisma.publishedSite.findUnique).mockResolvedValue(site);
    m(prisma.siteInvite.findUnique).mockResolvedValue(null);
    m(prisma.workspaceMember.findFirst).mockResolvedValue(null);
    expect((await siteAccessById("s1", "g@gmail.com")).result).toBe("forbidden");
  });
});

describe("recordSiteAccess", () => {
  beforeEach(() => vi.resetAllMocks());

  it("직전 기록이 10분 안이면 남기지 않는다", async () => {
    m(prisma.siteAccess.findFirst).mockResolvedValue({ createdAt: new Date(Date.now() - 60_000) });
    await recordSiteAccess({ siteId: "s1", email: "G@gmail.com", member: false, version: 2 });
    expect(m(prisma.siteAccess.findFirst).mock.calls[0][0]).toMatchObject({ where: { siteId: "s1", email: "g@gmail.com" } });
    expect(prisma.siteAccess.create).not.toHaveBeenCalled();
  });

  it("처음이거나 10분 지났으면 정규화한 이메일로 남긴다", async () => {
    m(prisma.siteAccess.findFirst).mockResolvedValue(null);
    await recordSiteAccess({ siteId: "s1", email: "G@gmail.com", member: true, version: 2 });
    expect(prisma.siteAccess.create).toHaveBeenCalledWith({ data: { siteId: "s1", email: "g@gmail.com", member: true, version: 2 } });
  });
});
