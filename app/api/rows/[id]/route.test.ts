import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/pageGuard", () => ({ requirePage: vi.fn(), pageAccess: vi.fn() }));
vi.mock("@/lib/relationServer", () => ({ validateRelationProps: vi.fn() }));
vi.mock("@/lib/notify", () => ({ notifyTaskAssigned: vi.fn(), notifyTaskStatus: vi.fn() }));
vi.mock("@/lib/activity", () => ({
  pushNotification: vi.fn(),
  recordActivity: vi.fn(),
  userIdsByNames: vi.fn(async () => []),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    dbRow: { findUnique: vi.fn(), update: vi.fn() },
    dbProperty: { findMany: vi.fn(async () => []) },
  },
}));

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { requirePage } from "@/lib/pageGuard";
import { PATCH } from "./route";

const m = (f: unknown) => f as Mock;
const ctx = { params: Promise.resolve({ id: "r1" }) };
const patch = (body: unknown) =>
  new Request("http://t/api/rows/r1", { method: "PATCH", body: JSON.stringify(body) });
const guard = { workspaceId: "w1", userId: "u1", role: "editor", actor: { type: "user", id: "u1", name: "U" } };

describe("PATCH /api/rows/[id] 본문 검증", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m(requireCtx).mockResolvedValue(guard);
    m(requirePage).mockResolvedValue({ idx: {} });
    m(prisma.dbRow.findUnique).mockResolvedValue({
      id: "r1",
      databasePageId: "b1",
      props: {},
      updatedAt: new Date(),
      database: { workspaceId: "w1", dbProperties: [] },
    });
    m(prisma.dbRow.update).mockResolvedValue({ id: "r1", position: 3 });
  });

  it.each([[null], ["3"], [-1], [1.5]])("position=%j → 400 + issues[0].path=position", async (position) => {
    const res = await PATCH(patch({ position }), ctx);
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.issues[0].path).toBe("position");
    expect(prisma.dbRow.update).not.toHaveBeenCalled();
  });

  it("인증이 본문 읽기보다 먼저다", async () => {
    m(requireCtx).mockResolvedValue({ err: NextResponse.json({}, { status: 401 }) });
    expect((await PATCH(patch({ position: null }), ctx)).status).toBe(401);
  });

  it("정상 position 은 기존 경로로 저장된다", async () => {
    const res = await PATCH(patch({ position: 3 }), ctx);
    expect(res.status).toBe(200);
    expect(prisma.dbRow.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ position: 3 }) }),
    );
  });
});
