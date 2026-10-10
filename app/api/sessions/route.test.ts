import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { claudeSession: { findMany: vi.fn() } } }));

import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { GET } from "./route";

const m = (f: unknown) => f as Mock;

describe("GET /api/sessions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "member" });
  });

  it("lastSeenAt 을 고르고 응답에 싣는다(대시보드 '최근 활동')", async () => {
    const seen = new Date("2026-10-09T03:00:00Z");
    m(prisma.claudeSession.findMany).mockResolvedValue([{ id: "s1", status: "active", lastSeenAt: seen }]);
    const body = await (await GET()).json();
    const arg = m(prisma.claudeSession.findMany).mock.calls[0][0] as { where: object; select: Record<string, unknown> };
    expect(arg.where).toEqual({ workspaceId: "w1" });
    expect(arg.select.lastSeenAt).toBe(true);
    expect(body.sessions[0].lastSeenAt).toBe(seen.toISOString());
  });
});
