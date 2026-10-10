import { describe, it, expect, vi } from "vitest";

const findMany = vi.fn<(args: unknown) => Promise<unknown[]>>(async () => []);
vi.mock("@/lib/prisma", () => ({
  prisma: {
    workspaceMember: { findMany: (a: unknown) => findMany(a) },
    team: { findMany: async () => [] },
  },
}));
vi.mock("@/lib/workspace", () => ({ getPageContext: async () => ({ workspaceId: "ws1", userId: "u1" }) }));
vi.mock("@/lib/membersAgents", () => ({ loadAgentTokenSummaries: async () => new Map() }));
vi.mock("@/components/ws/Members", () => ({ default: () => null }));

import MembersPage from "./page";

describe("멤버 서버 페이지", () => {
  it("GET /api/members 와 같이 removed 멤버를 뺀다(회수된 에이전트가 첫 화면에 남지 않게)", async () => {
    await MembersPage();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws1", status: { not: "removed" } } }),
    );
  });
});
