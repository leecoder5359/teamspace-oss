import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/graphLoad", () => ({ invalidateGraphCache: vi.fn() }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/projectRef", () => ({ resolveProjectRef: vi.fn(async (id?: string) => ({ ok: true, projectId: id ?? null })) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    decision: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
    project: { findFirst: vi.fn() },
  },
}));

import { requireCtx } from "@/lib/workspace";
import { invalidateGraphCache } from "@/lib/graphLoad";
import { prisma } from "@/lib/prisma";
import { POST } from "./route";
import { PATCH, DELETE } from "./[id]/route";

/* 원시 그래프는 SWR 로 최대 10분 낡을 수 있다 — projectId 이동은 권한이 바뀌는 쓰기라 즉시 비운다(리뷰 I-1). */
const m = (f: unknown) => f as Mock;
const params = { params: Promise.resolve({ id: "x1" }) };
const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("/api/decisions 쓰기는 그래프 캐시를 비운다", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor", actor: { type: "user", id: "u1", name: "U" } });
    m(prisma.decision.create).mockResolvedValue({ id: "x1" });
    m(prisma.decision.findFirst).mockResolvedValue({ id: "x1" });
    m(prisma.decision.update).mockResolvedValue({ id: "x1" });
    m(prisma.decision.deleteMany).mockResolvedValue({ count: 1 });
    m(prisma.project.findFirst).mockResolvedValue({ id: "locked" });
  });

  it("POST 생성", async () => {
    expect((await POST(new Request("http://t/api/decisions", json("POST", { title: "t" })))).status).toBe(200);
    expect(invalidateGraphCache).toHaveBeenCalledWith("w1");
  });

  it("PATCH 프로젝트 이동", async () => {
    expect((await PATCH(new Request("http://t/api/decisions/x1", json("PATCH", { projectId: "locked" })), params)).status).toBe(200);
    expect(invalidateGraphCache).toHaveBeenCalledWith("w1");
  });

  it("DELETE", async () => {
    expect((await DELETE(new Request("http://t/api/decisions/x1", { method: "DELETE" }), params)).status).toBe(200);
    expect(invalidateGraphCache).toHaveBeenCalledWith("w1");
  });

  it("없는 항목 PATCH(404)는 비우지 않는다", async () => {
    m(prisma.decision.findFirst).mockResolvedValue(null);
    expect((await PATCH(new Request("http://t/api/decisions/x1", json("PATCH", { title: "y" })), params)).status).toBe(404);
    expect(invalidateGraphCache).not.toHaveBeenCalled();
  });
});
