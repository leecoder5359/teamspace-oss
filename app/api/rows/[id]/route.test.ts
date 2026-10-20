import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/graphLoad", async (orig) => ({ ...(await orig<typeof import("@/lib/graphLoad")>()), invalidateGraphCache: vi.fn() }));
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
    dbRow: { findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
    dbProperty: { findMany: vi.fn(async () => []) },
  },
}));

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { requirePage } from "@/lib/pageGuard";
import { invalidateGraphCache } from "@/lib/graphLoad";
import { validateRelationProps } from "@/lib/relationServer";
import { PATCH, DELETE } from "./route";

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

/* 그래프는 SWR 로 최대 10분 낡는다 — 제목(text 속성)·문서 연결·삭제만 즉시 비운다. 상태 드래그 같은 잦은 쓰기는 비우지 않는다. */
describe("/api/rows/[id] 그래프 캐시 무효화", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    m(requireCtx).mockResolvedValue(guard);
    m(requirePage).mockResolvedValue({ idx: {} });
    m(prisma.dbRow.findUnique).mockResolvedValue({
      id: "r1", databasePageId: "b1", props: {}, updatedAt: new Date(),
      database: { workspaceId: "w1", dbProperties: [{ id: "title", type: "text" }, { id: "status", type: "select" }] },
    });
    m(prisma.dbRow.update).mockResolvedValue({ id: "r1" });
    m(prisma.dbRow.delete).mockResolvedValue({});
    const { validateRelationProps } = await import("@/lib/relationServer");
    m(validateRelationProps).mockImplementation(async (_b: string, props: unknown) => ({ ok: true, props }));
  });

  it("제목(text) 속성 변경은 비운다", async () => {
    expect((await PATCH(patch({ props: { title: "새 제목" } }), ctx)).status).toBe(200);
    expect(invalidateGraphCache).toHaveBeenCalledWith("w1");
  });

  it("상태(select)·위치만 바꾸면 비우지 않는다", async () => {
    expect((await PATCH(patch({ props: { status: "s2" }, position: 2 }), ctx)).status).toBe(200);
    expect(invalidateGraphCache).not.toHaveBeenCalled();
  });

  it("거절된 PATCH(다른 보드 속성 400)는 비우지 않는다", async () => {
    expect((await PATCH(patch({ props: { alien: "x" } }), ctx)).status).toBe(400);
    expect(invalidateGraphCache).not.toHaveBeenCalled();
  });

  it("DELETE 는 비우고, 다른 워크스페이스 행(404)은 비우지 않는다", async () => {
    expect((await DELETE(new Request("http://t/api/rows/r1", { method: "DELETE" }), ctx)).status).toBe(200);
    expect(invalidateGraphCache).toHaveBeenCalledWith("w1");
    m(invalidateGraphCache).mockClear();
    m(prisma.dbRow.findUnique).mockResolvedValue({ id: "r1", databasePageId: "b1", database: { workspaceId: "w2" } });
    expect((await DELETE(new Request("http://t/api/rows/r1", { method: "DELETE" }), ctx)).status).toBe(404);
    expect(invalidateGraphCache).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/rows/[id] 비정규화 칸(감사 P-14)", () => {
  const boardProps = [
    { id: "t", name: "제목", type: "text", config: {} },
    { id: "s", name: "상태", type: "select", config: { options: [{ id: "o1", name: "할 일" }, { id: "o2", name: "완료" }] } },
    { id: "a", name: "담당자", type: "text", config: {} },
  ];
  beforeEach(() => {
    vi.clearAllMocks();
    m(requireCtx).mockResolvedValue(guard);
    m(requirePage).mockResolvedValue({ idx: {} });
    m(prisma.dbRow.findUnique).mockResolvedValue({
      id: "r1", databasePageId: "b1", props: { t: "일", s: "o1", a: "A" }, updatedAt: new Date(),
      database: { workspaceId: "w1", dbProperties: boardProps.map(({ id, type }) => ({ id, type })) },
    });
    m(prisma.dbRow.update).mockResolvedValue({ id: "r1" });
    m(prisma.dbProperty.findMany).mockResolvedValue(boardProps);
    const rel = vi.mocked(validateRelationProps);
    rel.mockImplementation(async (_b: string, props: Record<string, unknown>) => ({ ok: true, props }) as never);
  });

  it("props 를 바꾸면 합친 props 로 칸을 다시 쓴다", async () => {
    expect((await PATCH(patch({ props: { s: "o2" } }), ctx)).status).toBe(200);
    expect(m(prisma.dbRow.update).mock.calls[0][0].data).toMatchObject({ props: { t: "일", s: "o2", a: "A" }, statusOptionId: "o2", assigneeText: "A", taskColsKey: "s|a" });
  });

  it("props 없이 위치만 바꾸면 칸을 건드리지 않는다", async () => {
    await PATCH(patch({ position: 1 }), ctx);
    const data = m(prisma.dbRow.update).mock.calls[0][0].data;
    expect(data).not.toHaveProperty("statusOptionId");
    expect(data).not.toHaveProperty("taskColsKey");
  });
});
