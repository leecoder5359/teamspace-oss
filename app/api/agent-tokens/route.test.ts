import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: vi.fn(), agentToken: { findMany: vi.fn() } } }));

import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { POST } from "./route";

const m = (f: unknown) => f as Mock;
const post = (body: unknown) =>
  POST(new Request("http://t/api/agent-tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

describe("POST /api/agent-tokens 예약 이름", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "admin" });
  });

  it.each(["legacy-cli", "  Legacy-CLI  "])("예약된 이름 %j 는 400, 토큰을 만들지 않는다", async (name) => {
    const res = await post({ name });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("예약");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("빈 이름도 400", async () => {
    expect((await post({ name: "  " })).status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("POST /api/agent-tokens 발급자(issuedById)", () => {
  function fakeTx() {
    return {
      user: { create: vi.fn().mockResolvedValue({ id: "sysU" }), update: vi.fn().mockResolvedValue({}) },
      agentToken: { create: vi.fn().mockResolvedValue({ id: "t1", name: "mac", role: "editor", createdAt: new Date(0) }) },
      workspaceMember: { create: vi.fn().mockResolvedValue({}) },
    };
  }
  async function issueAs(ctx: Record<string, unknown>) {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue(ctx);
    const tx = fakeTx();
    m(prisma.$transaction).mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => fn(tx));
    const res = await post({ name: "mac" });
    expect(res.status).toBe(200);
    return tx.agentToken.create.mock.calls[0][0].data as { userId: string; issuedById: string | null };
  }

  it("사람이 발급하면 그 사람", async () => {
    const data = await issueAs({ workspaceId: "w1", userId: "u1", role: "admin", actor: { type: "user", id: "u1", name: "이준" }, personId: "u1" });
    expect(data).toMatchObject({ userId: "sysU", issuedById: "u1" });
  });

  it("에이전트 토큰이 발급하면 그 토큰의 발급자, 부트스트랩(발급자 미상)이면 null", async () => {
    expect((await issueAs({ workspaceId: "w1", userId: "ag", role: "admin", actor: { type: "agent", id: "ag", name: "a" }, personId: "u7" })).issuedById).toBe("u7");
    expect((await issueAs({ workspaceId: "w1", userId: "ag", role: "admin", actor: { type: "agent", id: "ag", name: "legacy" }, personId: null })).issuedById).toBeNull();
  });
});
