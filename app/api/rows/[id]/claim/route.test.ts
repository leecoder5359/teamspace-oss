import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/pageGuard", () => ({ requirePage: vi.fn() }));
vi.mock("@/lib/notify", () => ({ notifyTaskAssigned: vi.fn() }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { dbRow: { findUnique: vi.fn(), updateMany: vi.fn() }, dbProperty: { findMany: vi.fn() } },
}));

import { requireCtx } from "@/lib/workspace";
import { requirePage } from "@/lib/pageGuard";
import { prisma } from "@/lib/prisma";
import { POST } from "./route";

const m = (f: unknown) => f as Mock;
const params = { params: Promise.resolve({ id: "r1" }) };
const claim = () => POST(new Request("http://t/api/rows/r1/claim", { method: "POST", body: "{}" }), params);
const UPDATED_AT = new Date("2026-10-20T00:00:00Z");

describe("POST /api/rows/[id]/claim 비정규화 칸(감사 P-14)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor", actor: { type: "agent", id: "u1", name: "Claude" } });
    m(requirePage).mockResolvedValue({ idx: {} });
    m(prisma.dbRow.findUnique).mockResolvedValue({
      id: "r1", databasePageId: "b1", props: { t: "일", s: "o1" }, updatedAt: UPDATED_AT, database: { workspaceId: "w1", deletedAt: null },
    });
    m(prisma.dbProperty.findMany).mockResolvedValue([
      { id: "t", name: "제목", type: "text", config: {} },
      { id: "s", name: "상태", type: "select", config: { options: [{ id: "o1", name: "할 일" }, { id: "o2", name: "진행 중" }] } },
      { id: "a", name: "담당자", type: "text", config: {} },
    ]);
    m(prisma.dbRow.updateMany).mockResolvedValue({ count: 1 });
  });

  it("담당자·진행 중 상태와 함께 칸을 CAS 로 쓴다", async () => {
    expect((await claim()).status).toBe(200);
    expect(m(prisma.dbRow.updateMany).mock.calls[0][0]).toEqual({
      where: { id: "r1", updatedAt: UPDATED_AT },
      data: { props: { t: "일", s: "o2", a: "Claude" }, statusOptionId: "o2", assigneeText: "Claude", taskColsKey: "s|a", updatedById: "u1" },
    });
    expect(m(prisma.dbProperty.findMany).mock.calls[0][0].orderBy).toEqual([{ position: "asc" }, { id: "asc" }]);
  });
});
