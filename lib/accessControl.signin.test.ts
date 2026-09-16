import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: { workspaceMember: { findFirst: vi.fn() }, siteInvite: { findFirst: vi.fn() } },
}));
import { prisma } from "@/lib/prisma";
import { isSignInAllowed } from "@/lib/accessControl";

const m = (f: unknown) => f as Mock;

describe("isSignInAllowed (c) 퍼블리시 게스트", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("AUTH_ALLOWED_DOMAINS", "");
    m(prisma.workspaceMember.findFirst).mockResolvedValue(null);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("살아 있는 사이트에 초대된 이메일은 허용", async () => {
    m(prisma.siteInvite.findFirst).mockResolvedValue({ id: "i1" });
    expect(await isSignInAllowed("Guest@Gmail.com")).toBe(true);
    expect(m(prisma.siteInvite.findFirst).mock.calls[0][0]).toMatchObject({
      where: { email: "guest@gmail.com", site: { is: { status: "active", deletedAt: null } } },
    });
  });

  it("초대도 멤버십도 도메인도 없으면 거부", async () => {
    m(prisma.siteInvite.findFirst).mockResolvedValue(null);
    expect(await isSignInAllowed("x@gmail.com")).toBe(false);
  });

  it("(a) 멤버는 초대 조회 없이 허용(회귀)", async () => {
    m(prisma.workspaceMember.findFirst).mockResolvedValue({ id: "m1" });
    expect(await isSignInAllowed("m@x.com")).toBe(true);
  });
});
