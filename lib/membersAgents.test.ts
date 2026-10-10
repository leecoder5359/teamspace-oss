import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: { agentToken: { findMany: vi.fn() } } }));

import { prisma } from "@/lib/prisma";
import { loadAgentTokenSummaries } from "./membersAgents";

const find = prisma.agentToken.findMany as unknown as Mock;
const mem = (userId: string, email: string) => ({ userId, user: { email } });

describe("loadAgentTokenSummaries", () => {
  beforeEach(() => vi.clearAllMocks());

  it("에이전트가 없으면 쿼리하지 않는다", async () => {
    const out = await loadAgentTokenSummaries("w1", [mem("u1", "h@x.com")]);
    expect(out.size).toBe(0);
    expect(find).not.toHaveBeenCalled();
  });

  it("에이전트가 여럿이어도 쿼리는 1회, 유저별 최신 1건을 ISO 로 반환", async () => {
    const d = new Date("2026-10-01T00:00:00Z");
    find.mockResolvedValue([
      { id: "t2", name: "bot", userId: "ua", lastUsedAt: d, revokedAt: null, createdAt: d },
      { id: "t1", name: "old", userId: "ua", lastUsedAt: null, revokedAt: d, createdAt: new Date(0) },
      { id: "t3", name: "b2", userId: "ub", lastUsedAt: null, revokedAt: null, createdAt: d },
    ]);
    const out = await loadAgentTokenSummaries("w1", [
      mem("ua", "agent-t2@agents.teamspace.local"),
      mem("ub", "agent-t3@agents.teamspace.local"),
      mem("u1", "h@x.com"),
    ]);
    expect(find).toHaveBeenCalledTimes(1);
    expect(out.get("ua")).toEqual({ id: "t2", name: "bot", lastUsedAt: d.toISOString(), revokedAt: null });
    expect(out.get("ub")?.id).toBe("t3");
    expect(out.has("u1")).toBe(false);
  });
});
