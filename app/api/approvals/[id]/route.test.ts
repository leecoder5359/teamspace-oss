import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/approvals", () => ({ applyDecision: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { approval: { findFirst: vi.fn() } } }));

import { requireCtx } from "@/lib/workspace";
import { applyDecision } from "@/lib/approvals";
import { prisma } from "@/lib/prisma";
import { PATCH } from "./route";

const m = (f: unknown) => f as Mock;
const agent = { workspaceId: "w1", userId: "a1", role: "admin", actor: { type: "agent", id: "a1", name: "bot" } };
const human = { workspaceId: "w1", userId: "u1", role: "editor", actor: { type: "user", id: "u1", name: "U" } };
const params = { params: Promise.resolve({ id: "ap1" }) };
const req = () => new Request("http://t/api/approvals/ap1", { method: "PATCH", body: JSON.stringify({ status: "approved" }) });

describe("PATCH /api/approvals/[id] — 고위험은 사람만", () => {
  beforeEach(() => vi.resetAllMocks());

  it("에이전트가 고위험 승인을 결정하려 하면 403, 결정은 기록되지 않는다", async () => {
    m(requireCtx).mockResolvedValue(agent);
    m(prisma.approval.findFirst).mockResolvedValue({ id: "ap1", status: "pending", highRisk: true });
    const res = await PATCH(req(), params);
    expect(res.status).toBe(403);
    expect(applyDecision).not.toHaveBeenCalled();
  });

  it("사람은 고위험 승인을 결정할 수 있다", async () => {
    m(requireCtx).mockResolvedValue(human);
    m(prisma.approval.findFirst).mockResolvedValue({ id: "ap1", status: "pending", highRisk: true });
    const res = await PATCH(req(), params);
    expect(res.status).toBe(200);
    expect(applyDecision).toHaveBeenCalledWith("ap1", expect.objectContaining({ status: "approved", userId: "u1" }));
  });

  it("에이전트도 일반 승인은 종전대로 결정할 수 있다", async () => {
    m(requireCtx).mockResolvedValue(agent);
    m(prisma.approval.findFirst).mockResolvedValue({ id: "ap1", status: "pending", highRisk: false });
    const res = await PATCH(req(), params);
    expect(res.status).toBe(200);
  });
});
