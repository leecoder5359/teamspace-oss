import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
  headers: vi.fn(async () => ({ get: () => null })),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findFirst: vi.fn() },
    workspace: { findFirst: vi.fn() },
    workspaceMember: { updateMany: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    agentToken: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

import { auth } from "@/auth";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

const m = (f: unknown) => f as Mock;
const member = (workspaceId: string, status: string) => ({ id: `m-${workspaceId}`, workspaceId, userId: "u1", role: "editor", status, createdAt: new Date(0) });

/* 감사 P-10 — 요청마다 나가던 쓰기를 필요할 때만. */
describe("resolveSessionCtx — 초대 수락 쓰기는 invited 행이 있을 때만", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(auth).mockResolvedValue({ user: { id: "u1", email: "a@gmail.com" } });
    m(prisma.user.findFirst).mockResolvedValue({ id: "u1", name: "A", email: "a@gmail.com" });
    m(prisma.workspaceMember.updateMany).mockResolvedValue({ count: 1 });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("invited 가 없으면 updateMany 를 부르지 않는다", async () => {
    m(prisma.workspaceMember.findMany).mockResolvedValue([member("w1", "active")]);
    const ctx = await requireCtx("viewer");
    expect(ctx).toMatchObject({ workspaceId: "w1" });
    expect(prisma.workspaceMember.updateMany).not.toHaveBeenCalled();
    expect(m(prisma.workspaceMember.findMany).mock.calls[0][0].where).toEqual({ userId: "u1", status: { in: ["active", "invited"] } });
  });

  it("invited 가 있으면 수락하고 그 멤버십을 바로 쓴다", async () => {
    m(prisma.workspaceMember.findMany).mockResolvedValue([member("w2", "invited")]);
    const ctx = await requireCtx("viewer");
    expect(prisma.workspaceMember.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["m-w2"] }, status: "invited" }, data: { status: "active" } });
    expect(ctx).toMatchObject({ workspaceId: "w2", role: "editor" });
    expect(prisma.workspaceMember.findMany).toHaveBeenCalledTimes(1); // 다 수락됐으면 다시 읽지 않는다
  });

  it("읽은 뒤 초대가 제거되면(count 가 모자람) 다시 읽어 active 가 된 것만 쓴다", async () => {
    vi.stubEnv("AUTH_ALLOWED_DOMAINS", "team.com");
    m(prisma.workspaceMember.findMany)
      .mockResolvedValueOnce([member("w2", "invited")])
      .mockResolvedValueOnce([]); // 다시 읽기: m-w2 는 이제 removed — active 아님
    m(prisma.workspaceMember.updateMany).mockResolvedValue({ count: 0 });
    const r = await requireCtx("viewer");
    expect(m(prisma.workspaceMember.findMany).mock.calls[1][0]).toEqual({ where: { id: { in: ["m-w2"] }, status: "active" }, select: { id: true } });
    expect("err" in r && r.err.status).toBe(403);
  });

  it("동시 요청이 먼저 수락했으면(count 0 이지만 active) 그 멤버십을 쓴다", async () => {
    m(prisma.workspaceMember.findMany)
      .mockResolvedValueOnce([member("w2", "invited")])
      .mockResolvedValueOnce([{ id: "m-w2" }]);
    m(prisma.workspaceMember.updateMany).mockResolvedValue({ count: 0 });
    const ctx = await requireCtx("viewer");
    expect(ctx).toMatchObject({ workspaceId: "w2", role: "editor" });
  });

  it("수락 쓰기가 실패하면 invited 멤버십은 쓰지 않는다(이전과 같음)", async () => {
    vi.stubEnv("AUTH_ALLOWED_DOMAINS", "team.com");
    m(prisma.workspaceMember.findMany).mockResolvedValue([member("w2", "invited")]);
    m(prisma.workspaceMember.updateMany).mockRejectedValue(new Error("db"));
    const r = await requireCtx("viewer");
    expect("err" in r && r.err.status).toBe(403);
  });
});

describe("resolveAgentCtx — lastUsedAt 은 60초 넘게 지났을 때만 갱신", () => {
  const TOKEN = `wst_${"a".repeat(64)}`;
  const token = (lastUsedAt: Date | null) => ({ id: "t1", workspaceId: "w1", userId: "agentU", name: "mac", role: "editor", revokedAt: null, issuedById: null, lastUsedAt });

  beforeEach(() => {
    vi.resetAllMocks();
    m(auth).mockResolvedValue(null);
    m(headers).mockResolvedValue(new Headers({ "x-ws-token": TOKEN }));
    m(prisma.agentToken.update).mockResolvedValue({});
  });

  it("처음 쓰는 토큰(null)은 갱신", async () => {
    m(prisma.agentToken.findUnique).mockResolvedValue(token(null));
    await requireCtx("viewer");
    expect(prisma.agentToken.update).toHaveBeenCalledTimes(1);
  });

  it("30초 전에 쓴 토큰은 갱신하지 않는다", async () => {
    m(prisma.agentToken.findUnique).mockResolvedValue(token(new Date(Date.now() - 30_000)));
    const ctx = await requireCtx("viewer");
    expect(ctx).toMatchObject({ userId: "agentU" });
    expect(prisma.agentToken.update).not.toHaveBeenCalled();
  });

  it("61초 전에 쓴 토큰은 갱신", async () => {
    m(prisma.agentToken.findUnique).mockResolvedValue(token(new Date(Date.now() - 61_000)));
    await requireCtx("viewer");
    expect(prisma.agentToken.update).toHaveBeenCalledTimes(1);
  });
});
