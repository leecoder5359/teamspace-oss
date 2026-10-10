import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    workspaceMember: { findMany: vi.fn() },
    agentToken: { findMany: vi.fn() },
  },
}));

import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { GET } from "./route";

const m = (f: unknown) => f as Mock;
const member = (id: string, userId: string, email: string) => ({
  id, userId, role: "editor", status: "active", teamId: null,
  user: { id: userId, name: id, email, image: null },
});

describe("GET /api/members", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "viewer" });
    m(prisma.agentToken.findMany).mockResolvedValue([]);
  });

  it("requireCtx 기본 하한(인자 없음) 그대로 — 거절은 그대로 반환", async () => {
    m(requireCtx).mockResolvedValue({ err: NextResponse.json({}, { status: 401 }) });
    expect((await GET()).status).toBe(401);
    expect(requireCtx).toHaveBeenCalledWith();
    expect(prisma.workspaceMember.findMany).not.toHaveBeenCalled();
  });

  it("viewer 도 읽을 수 있다", async () => {
    m(prisma.workspaceMember.findMany).mockResolvedValue([member("h", "u1", "h@x.com")]);
    expect((await GET()).status).toBe(200);
  });

  it("사람은 kind=human, agentToken=null", async () => {
    m(prisma.workspaceMember.findMany).mockResolvedValue([member("h", "u1", "h@x.com")]);
    const body = await (await GET()).json();
    expect(body.members[0]).toMatchObject({ id: "h", kind: "human", agentToken: null });
    expect(prisma.agentToken.findMany).not.toHaveBeenCalled();
  });

  it("에이전트는 kind=agent + 가장 최근 토큰 요약", async () => {
    m(prisma.workspaceMember.findMany).mockResolvedValue([member("a", "ua", "agent-t2@agents.teamspace.local")]);
    const d = new Date("2026-10-01T00:00:00Z");
    m(prisma.agentToken.findMany).mockResolvedValue([
      { id: "t2", name: "bot", userId: "ua", lastUsedAt: d, revokedAt: null, createdAt: d },
      { id: "t1", name: "old", userId: "ua", lastUsedAt: null, revokedAt: d, createdAt: new Date(0) },
    ]);
    const body = await (await GET()).json();
    expect(body.members[0]).toMatchObject({
      kind: "agent",
      agentToken: { id: "t2", name: "bot", lastUsedAt: d.toISOString(), revokedAt: null },
    });
  });

  it("에이전트 2명이어도 agentToken.findMany 는 1회", async () => {
    m(prisma.workspaceMember.findMany).mockResolvedValue([
      member("a1", "ua1", "agent-t1@agents.teamspace.local"),
      member("a2", "ua2", "agent-t2@agents.teamspace.local"),
    ]);
    await GET();
    expect(prisma.agentToken.findMany).toHaveBeenCalledTimes(1);
    expect(m(prisma.agentToken.findMany).mock.calls[0][0].where).toMatchObject({
      workspaceId: "w1", userId: { in: ["ua1", "ua2"] },
    });
  });
});
