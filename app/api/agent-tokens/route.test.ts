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
