import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/idempotency", () => ({ withIdempotency: (_r: unknown, _g: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/activity", () => ({ pushNotification: vi.fn(async () => {}), recordActivity: vi.fn() }));
vi.mock("@/lib/approvals", () => ({ sendApproval: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { workspaceMember: { findMany: vi.fn() }, approval: { findMany: vi.fn() } } }));

import { requireCtx } from "@/lib/workspace";
import { pushNotification } from "@/lib/activity";
import { sendApproval } from "@/lib/approvals";
import { prisma } from "@/lib/prisma";
import { POST } from "./route";

const m = (f: unknown) => f as Mock;

describe("POST /api/approvals — 인앱 알림 링크", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor" });
    m(sendApproval).mockResolvedValue({ id: "ap123", sent: true });
    m(prisma.workspaceMember.findMany).mockResolvedValue([{ userId: "a1" }]);
  });

  it("알림 link 에 approvalId 를 싣는다(/approvals?id=<id>)", async () => {
    const res = await POST(new Request("http://t/api/approvals", { method: "POST", body: JSON.stringify({ title: "배포" }) }));
    expect(res.status).toBe(200);
    expect(m(pushNotification).mock.calls[0][4]).toBe("/approvals?id=ap123");
  });

  it("kind 는 ApprovalKind 열거값만 — 모르는 값은 400(sendApproval 안 부름), 맞는 값은 그대로 전달", async () => {
    const bad = await POST(new Request("http://t/api/approvals", { method: "POST", body: JSON.stringify({ title: "배포", kind: "nope" }) }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).issues[0].path).toBe("kind");
    expect(sendApproval).not.toHaveBeenCalled();
    const ok = await POST(new Request("http://t/api/approvals", { method: "POST", body: JSON.stringify({ title: "배포", kind: "deploy" }) }));
    expect(ok.status).toBe(200);
    expect(m(sendApproval).mock.calls[0][1]).toMatchObject({ kind: "deploy" });
  });
});
