import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/graphLoad", () => ({ invalidateGraphCache: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { lesson: { findUnique: vi.fn(), update: vi.fn() } } }));
vi.mock("@/lib/projectRef", () => ({
  resolveProjectRef: vi.fn(async (id: string | null) =>
    id === "bad" ? { ok: false, err: new Response(JSON.stringify({ error: "x" }), { status: 400 }) } : { ok: true, projectId: id || null }),
}));

import { requireCtx } from "@/lib/workspace";
import { invalidateGraphCache } from "@/lib/graphLoad";
import { prisma } from "@/lib/prisma";
import { POST } from "./route";

const m = (f: unknown) => f as Mock;
const call = (body: unknown = {}) =>
  POST(
    new Request("http://t/api/lessons/L1/promote", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: "L1" }) },
  );
const lesson = (x: Record<string, unknown> = {}) => ({ id: "L1", workspaceId: "w1", userId: "b", projectId: null, stack: null, mode: "default", ...x });

beforeEach(() => {
  vi.resetAllMocks();
  m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "boss", role: "admin", personId: "boss" });
  m(prisma.lesson.update).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => lesson(data));
});

describe("POST /api/lessons/[id]/promote", () => {
  it("projectId 없으면 전역, 있으면 그 프로젝트 — userId·stack 을 비운다", async () => {
    m(prisma.lesson.findUnique).mockResolvedValue(lesson());
    const res = await call();
    expect(res.status).toBe(200);
    expect(m(prisma.lesson.update).mock.calls[0][0].data).toEqual({ userId: null, projectId: null, stack: null, sharedWithTeam: true });
    expect((await res.json()).lesson).toMatchObject({ scope: "global", personal: false });
    await call({ projectId: "p1" });
    expect(m(prisma.lesson.update).mock.calls[1][0].data).toMatchObject({ userId: null, projectId: "p1" });
  });
  it("개인 레슨이 아니면 400, 프로젝트가 틀리면 400, 없거나 다른 워크스페이스면 404", async () => {
    m(prisma.lesson.findUnique).mockResolvedValue(lesson({ userId: null }));
    expect((await call()).status).toBe(400);
    m(prisma.lesson.findUnique).mockResolvedValue(lesson());
    expect((await call({ projectId: "bad" })).status).toBe(400);
    m(prisma.lesson.findUnique).mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    m(prisma.lesson.findUnique).mockResolvedValue(lesson({ workspaceId: "w2" }));
    expect((await call()).status).toBe(404);
    expect(prisma.lesson.update).not.toHaveBeenCalled();
  });
  it("admin 이 아니면 requireCtx 가 막는다", async () => {
    m(requireCtx).mockResolvedValue({ err: new Response(null, { status: 403 }) });
    expect((await call()).status).toBe(403);
    expect(m(requireCtx).mock.calls[0][0]).toBe("admin");
  });
});

describe("POST /api/lessons/[id]/promote — 그래프 캐시(리뷰 I-1)", () => {
  it("팀 레슨으로 올리면 그래프에 새로 들어오므로 비운다, 거절은 비우지 않는다", async () => {
    m(prisma.lesson.findUnique).mockResolvedValue(lesson());
    expect((await call()).status).toBe(200);
    expect(invalidateGraphCache).toHaveBeenCalledWith("w1");
    m(invalidateGraphCache).mockClear();
    m(prisma.lesson.findUnique).mockResolvedValue(lesson({ userId: null }));
    expect((await call()).status).toBe(400);
    expect(invalidateGraphCache).not.toHaveBeenCalled();
  });
});
