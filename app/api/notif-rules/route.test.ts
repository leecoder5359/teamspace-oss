import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { notifRule: { create: vi.fn(), findMany: vi.fn() } } }));
vi.mock("@/lib/projectRef", () => ({ resolveProjectRef: vi.fn(async (id?: string) => ({ ok: true, projectId: id ?? null })) }));

import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { NotifEvent } from "@/app/generated/prisma/enums";
import { POST } from "./route";

const m = (f: unknown) => f as Mock;
const post = (body: unknown) => POST(new Request("http://t/api/notif-rules", { method: "POST", body: JSON.stringify(body) }));

describe("POST /api/notif-rules — 이벤트 화이트리스트", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "admin" });
    m(prisma.notifRule.create).mockImplementation(async (a: { data: unknown }) => a.data);
  });

  it("weekly_digest 규칙(프로젝트 스코프)을 만들 수 있다", async () => {
    const res = await post({ event: "weekly_digest", targetId: " C123 ", projectId: "p1" });
    expect(res.status).toBe(200);
    expect(m(prisma.notifRule.create).mock.calls[0][0].data).toEqual({ workspaceId: "w1", event: "weekly_digest", target: "channel", targetId: "C123", projectId: "p1" });
  });

  it("NotifEvent enum 의 모든 값을 허용한다(화이트리스트가 enum 에 뒤처지지 않게)", async () => {
    for (const ev of Object.values(NotifEvent)) {
      expect((await post({ event: ev, targetId: "C1" })).status, ev).toBe(200);
    }
  });

  it("모르는 이벤트는 400", async () => {
    expect((await post({ event: "weekly", targetId: "C1" })).status).toBe(400);
    expect(prisma.notifRule.create).not.toHaveBeenCalled();
  });
});
