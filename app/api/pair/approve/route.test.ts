import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: vi.fn() } }));
import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { POST } from "./route";

/** $transaction 콜백에 넘길 가짜 tx. 호출 이력을 그대로 들여다본다. */
function fakeTx(prior: { agentTokenId: string; userId: string } | null) {
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    pairing: { findUnique: vi.fn().mockResolvedValue(prior), upsert: vi.fn().mockResolvedValue({}) },
    agentToken: {
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({ id: "tok_new" }),
    },
    user: { create: vi.fn().mockResolvedValue({ id: "u_new" }), update: vi.fn().mockResolvedValue({}) },
    workspaceMember: { create: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
}

function req(body: unknown) {
  return new Request("http://t/api/pair/approve", { method: "POST", body: JSON.stringify(body) });
}
beforeEach(() => vi.clearAllMocks());

describe("POST /api/pair/approve", () => {
  it("미로그인 → requireCtx 의 401 그대로", async () => {
    (requireCtx as unknown as Mock).mockResolvedValue({ err: new Response("no", { status: 401 }) });
    const res = await POST(req({ code: "a".repeat(32) }));
    expect(res.status).toBe(401);
  });
  it("code 없으면 400", async () => {
    (requireCtx as unknown as Mock).mockResolvedValue({ workspaceId: "w", userId: "u", role: "editor" });
    const res = await POST(req({}));
    expect(res.status).toBe(400);
  });
  it("code 형식 오류(32hex 아님) → 400", async () => {
    (requireCtx as unknown as Mock).mockResolvedValue({ workspaceId: "w", userId: "u", role: "editor" });
    const res = await POST(req({ code: "xyz" }));
    expect(res.status).toBe(400);
  });
  it("requireCtx 를 admin 게이트로 호출한다 (새 머신 프로비저닝 = admin 액션)", async () => {
    (requireCtx as unknown as Mock).mockResolvedValue({ err: new Response("no", { status: 403 }) });
    await POST(req({ code: "a".repeat(32) }));
    expect(requireCtx).toHaveBeenCalledWith("admin");
  });
});

describe("POST /api/pair/approve — 동시 승인·재승인 (설치기 후속)", () => {
  beforeEach(() => vi.clearAllMocks());

  async function run(prior: { agentTokenId: string; userId: string } | null) {
    (requireCtx as unknown as Mock).mockResolvedValue({ workspaceId: "w", userId: "u", role: "admin" });
    const tx = fakeTx(prior);
    (prisma.$transaction as unknown as Mock).mockImplementation(async (fn: (t: unknown) => Promise<void>) => fn(tx));
    const res = await POST(req({ code: "a".repeat(32) }));
    return { res, tx };
  }

  it("code 단위 advisory lock 을 트랜잭션 안에서 먼저 잡는다", async () => {
    const { res, tx } = await run(null);
    expect(res.status).toBe(200);
    expect(tx.$executeRaw).toHaveBeenCalled();
    // 잠금이 조회보다 먼저여야 의미가 있다
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.pairing.findUnique.mock.invocationCallOrder[0]);
  });

  it("구 토큰 조회를 트랜잭션 **안에서** 한다 (밖에서 읽으면 동시 승인에 고아 토큰이 남는다)", async () => {
    const { tx } = await run(null);
    expect(tx.pairing.findUnique).toHaveBeenCalledWith({
      where: { code: "a".repeat(32) },
      select: { agentTokenId: true, userId: true },
    });
  });

  it("재승인이면 구 토큰을 회수하고 구 멤버십을 removed 로 내린다", async () => {
    const { res, tx } = await run({ agentTokenId: "tok_old", userId: "u_old" });
    expect(res.status).toBe(200);
    expect(tx.agentToken.update).toHaveBeenCalledWith({
      where: { id: "tok_old" },
      data: { revokedAt: expect.any(Date) },
    });
    expect(tx.workspaceMember.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: "w", userId: "u_old" },
      data: { status: "removed" },
    });
  });

  it("첫 승인이면 회수할 것도 내릴 멤버십도 없다", async () => {
    const { tx } = await run(null);
    expect(tx.agentToken.update).not.toHaveBeenCalled();
    expect(tx.workspaceMember.updateMany).not.toHaveBeenCalled();
    expect(tx.workspaceMember.create).toHaveBeenCalled();
  });
});

describe("POST /api/pair/approve — 발급자(issuedById)", () => {
  async function approveAs(ctx: Record<string, unknown>) {
    (requireCtx as unknown as Mock).mockResolvedValue(ctx);
    const tx = fakeTx(null);
    (prisma.$transaction as unknown as Mock).mockImplementation(async (fn: (t: unknown) => Promise<void>) => fn(tx));
    await POST(req({ code: "b".repeat(32) }));
    return tx.agentToken.create.mock.calls[0][0].data as { userId: string; issuedById: string | null };
  }

  it("승인한 사람을 issuedById 로 남긴다 — userId 는 새 에이전트 시스템 User", async () => {
    const data = await approveAs({ workspaceId: "w", userId: "human1", role: "admin", actor: { type: "user", id: "human1", name: "이준" }, personId: "human1" });
    expect(data.issuedById).toBe("human1");
    expect(data.userId).toBe("u_new");
  });

  it("에이전트 토큰이 승인하면 그 토큰의 발급자를 잇는다, 발급자 미상이면 null", async () => {
    expect((await approveAs({ workspaceId: "w", userId: "agentU", role: "admin", actor: { type: "agent", id: "agentU", name: "a" }, personId: "human9" })).issuedById).toBe("human9");
    expect((await approveAs({ workspaceId: "w", userId: "agentU", role: "admin", actor: { type: "agent", id: "agentU", name: "a" }, personId: null })).issuedById).toBeNull();
  });
});
