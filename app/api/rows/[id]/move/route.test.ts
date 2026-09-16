import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/pageGuard", () => ({
  requirePage: vi.fn(),
  gatePage: vi.fn(),
  notFound: () => NextResponse.json({ error: "페이지를 찾을 수 없습니다." }, { status: 404 }),
}));
vi.mock("@/lib/relationServer", () => ({ validateRelationProps: vi.fn() }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/prisma", () => {
  const tx = {
    dbProperty: { findUnique: vi.fn(), update: vi.fn() },
    dbRow: { updateMany: vi.fn() },
  };
  return {
    prisma: {
      $transaction: vi.fn(),
      dbRow: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
      dbProperty: { findMany: vi.fn() },
      page: { findUnique: vi.fn() },
      __tx: tx,
    },
  };
});

import { requireCtx } from "@/lib/workspace";
import { requirePage, gatePage } from "@/lib/pageGuard";
import { validateRelationProps } from "@/lib/relationServer";
import { recordActivity } from "@/lib/activity";
import { prisma } from "@/lib/prisma";
import { POST } from "./route";

const m = (f: unknown) => f as Mock;
const tx = (prisma as unknown as { __tx: { dbProperty: { findUnique: Mock; update: Mock }; dbRow: { updateMany: Mock } } }).__tx;
const params = { params: Promise.resolve({ id: "row1" }) };
const req = (body: unknown) => new Request("http://t/api/rows/row1/move", { method: "POST", body: JSON.stringify(body) });

const UPDATED_AT = new Date("2026-09-16T00:00:00.000Z");
const srcProps = [
  { id: "s-title", name: "이름", type: "text", config: {} },
  { id: "s-status", name: "상태", type: "select", config: { options: [{ id: "s-doing", name: "진행 중", color: "blue" }, { id: "s-rev", name: "검토", color: "purple" }] } },
];
const tgtProps = [
  { id: "t-title", name: "이름", type: "text", config: {} },
  { id: "t-status", name: "상태", type: "select", config: { options: [{ id: "t-doing", name: "진행 중" }] } },
];
const row = (props: Record<string, unknown> = { "s-title": "작업", "s-status": "s-doing" }) => ({
  id: "row1",
  databasePageId: "boardA",
  props,
  position: 3,
  parentRowId: "p0",
  updatedAt: UPDATED_AT,
  database: { workspaceId: "w1", title: "A", dbProperties: srcProps },
});
const targetPage = { id: "boardB", kind: "database", title: "B 보드", workspaceId: "w1", deletedAt: null, dbProperties: tgtProps };

describe("POST /api/rows/[id]/move", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor", actor: { type: "agent", id: "u1", name: "에이전트" } });
    m(requirePage).mockResolvedValue({ idx: {}, level: "edit" });
    m(gatePage).mockReturnValue({ idx: {}, level: "edit" });
    m(prisma.dbRow.findUnique).mockResolvedValue(row());
    m(prisma.page.findUnique).mockResolvedValue(targetPage);
    m(prisma.dbRow.count).mockResolvedValue(0);
    m(prisma.dbRow.findFirst).mockResolvedValue({ position: 9 });
    m(prisma.dbRow.findMany).mockResolvedValue([]);
    m(prisma.dbProperty.findMany).mockResolvedValue([]);
    m(validateRelationProps).mockImplementation(async (_id: string, props: Record<string, unknown>) => ({ ok: true, props }));
    m(prisma.$transaction).mockImplementation(async (fn: (t: unknown) => unknown) => fn(tx));
    tx.dbRow.updateMany.mockResolvedValue({ count: 1 });
  });

  it("인증 실패는 그대로", async () => {
    m(requireCtx).mockResolvedValue({ err: new Response(null, { status: 401 }) });
    expect((await POST(req({ targetDatabaseId: "boardB" }), params)).status).toBe(401);
  });

  it("targetDatabaseId 가 없으면 400", async () => {
    expect((await POST(req({}), params)).status).toBe(400);
  });

  it("다른 워크스페이스의 행은 404", async () => {
    m(prisma.dbRow.findUnique).mockResolvedValue({ ...row(), database: { ...row().database, workspaceId: "w2" } });
    expect((await POST(req({ targetDatabaseId: "boardB" }), params)).status).toBe(404);
  });

  it("원본 보드를 편집할 수 없으면 게이트 응답(404/403)", async () => {
    m(requirePage).mockResolvedValue({ err: NextResponse.json({}, { status: 404 }) });
    expect((await POST(req({ targetDatabaseId: "boardB" }), params)).status).toBe(404);
    expect(m(requirePage).mock.calls[0][1]).toBe("boardA");
  });

  it("같은 보드로는 400", async () => {
    expect((await POST(req({ targetDatabaseId: "boardA" }), params)).status).toBe(400);
  });

  // D3: "존재하지만 못 본다" 와 "아예 없다" 는 상태+본문이 완전히 같아야 한다.
  // gatePage 가 돌려주는 not-found 응답(위 mock)을 기준으로 삼는다.
  const GATE_NOT_FOUND = { status: 404, body: { error: "페이지를 찾을 수 없습니다." } };
  const expectGateNotFound = async (res: Response) => {
    expect(res.status).toBe(GATE_NOT_FOUND.status);
    expect(await res.json()).toEqual(GATE_NOT_FOUND.body);
  };

  it("대상 보드를 볼 수 없으면(게이트 거부) 대상을 조회하지 않고 게이트와 동일한 404", async () => {
    m(gatePage).mockReturnValue({ err: NextResponse.json({ error: "페이지를 찾을 수 없습니다." }, { status: 404 }) });
    const res = await POST(req({ targetDatabaseId: "boardB" }), params);
    await expectGateNotFound(res);
    expect(m(gatePage).mock.calls[0].slice(1)).toEqual(["boardB", "edit"]);
    // 게이트가 먼저 막았으니 대상 페이지를 조회할 필요가 없다(존재 여부를 새어나가게 하지 않는다).
    expect(prisma.page.findUnique).not.toHaveBeenCalled();
    expect(tx.dbRow.updateMany).not.toHaveBeenCalled();
  });

  it("대상 보드를 편집할 수 없으면(볼 수는 있음) 게이트의 403 그대로", async () => {
    m(gatePage).mockReturnValue({ err: NextResponse.json({ error: "이 페이지를 편집할 권한이 없습니다." }, { status: 403 }) });
    const res = await POST(req({ targetDatabaseId: "boardB" }), params);
    expect(res.status).toBe(403);
    expect(tx.dbRow.updateMany).not.toHaveBeenCalled();
  });

  it("대상 id 가 존재하지 않으면 게이트의 not-found 와 동일한 응답", async () => {
    m(prisma.page.findUnique).mockResolvedValue(null);
    await expectGateNotFound(await POST(req({ targetDatabaseId: "boardB" }), params));
  });

  it("대상이 다른 워크스페이스의 페이지면 게이트의 not-found 와 동일한 응답", async () => {
    m(prisma.page.findUnique).mockResolvedValue({ ...targetPage, workspaceId: "w2" });
    await expectGateNotFound(await POST(req({ targetDatabaseId: "boardB" }), params));
  });

  it("대상이 삭제된 보드면 게이트의 not-found 와 동일한 응답", async () => {
    m(prisma.page.findUnique).mockResolvedValue({ ...targetPage, deletedAt: new Date() });
    await expectGateNotFound(await POST(req({ targetDatabaseId: "boardB" }), params));
  });

  it("대상이 database 가 아니면 게이트의 not-found 와 동일한 응답", async () => {
    m(prisma.page.findUnique).mockResolvedValue({ ...targetPage, kind: "doc" });
    await expectGateNotFound(await POST(req({ targetDatabaseId: "boardB" }), params));
  });

  it("expectedUpdatedAt 불일치 → 409 + 현재 행", async () => {
    const res = await POST(req({ targetDatabaseId: "boardB", expectedUpdatedAt: "2020-01-01T00:00:00.000Z" }), params);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.conflict).toBe(true);
    expect(body.currentUpdatedAt).toBe(UPDATED_AT.toISOString());
    expect(body.row.id).toBe("row1");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("하위 항목이 있으면 409 + childCount", async () => {
    m(prisma.dbRow.count).mockResolvedValue(2);
    const res = await POST(req({ targetDatabaseId: "boardB" }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).childCount).toBe(2);
  });

  it("대상에 제목(text) 속성이 없으면 400 + 보고", async () => {
    m(prisma.page.findUnique).mockResolvedValue({ ...targetPage, dbProperties: [tgtProps[1]] });
    const res = await POST(req({ targetDatabaseId: "boardB" }), params);
    expect(res.status).toBe(400);
    expect((await res.json()).dropped.some((d: { name: string }) => d.name === "이름")).toBe(true);
  });

  it("dryRun 은 보고만 하고 아무것도 쓰지 않는다", async () => {
    m(prisma.dbRow.findUnique).mockResolvedValue(row({ "s-title": "작업", "s-status": "s-rev" }));
    const res = await POST(req({ targetDatabaseId: "boardB", dryRun: true }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, dryRun: true, referencedBy: 0, createdOptions: [] });
    expect(body.mapped).toEqual([{ name: "이름", type: "text" }]);
    expect(body.dropped[0]).toMatchObject({ name: "상태", type: "select", value: "검토" });
    expect(body.row).toBeUndefined();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("성공: 보드·props·position·parentRowId 를 CAS 로 갱신하고 활동을 남긴다", async () => {
    const res = await POST(req({ targetDatabaseId: "boardB" }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, dryRun: false, row: { id: "row1", databasePageId: "boardB" } });
    const call = tx.dbRow.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ id: "row1", databasePageId: "boardA", updatedAt: UPDATED_AT });
    expect(call.data).toEqual({
      databasePageId: "boardB",
      props: { "t-title": "작업", "t-status": "t-doing" },
      position: 10,
      parentRowId: null,
      updatedById: "u1",
    });
    expect(recordActivity).toHaveBeenCalledWith(expect.anything(), "moved", "task", "작업 → B 보드", "row1");
    expect(tx.dbProperty.update).not.toHaveBeenCalled();
  });

  it("createMissingOptions: 대상 속성에 옵션을 추가하고 그 id 로 저장한다", async () => {
    m(prisma.dbRow.findUnique).mockResolvedValue(row({ "s-title": "작업", "s-status": "s-rev" }));
    tx.dbProperty.findUnique.mockResolvedValue({ config: tgtProps[1].config });
    const res = await POST(req({ targetDatabaseId: "boardB", createMissingOptions: true }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.createdOptions).toHaveLength(1);
    expect(body.createdOptions[0]).toMatchObject({ property: "상태", option: { name: "검토", color: "purple" } });
    const newId = body.createdOptions[0].option.id;
    const upd = tx.dbProperty.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: "t-status" });
    expect(upd.data.config.options.map((o: { name: string }) => o.name)).toEqual(["진행 중", "검토"]);
    expect(tx.dbRow.updateMany.mock.calls[0][0].data.props["t-status"]).toBe(newId);
  });

  it("createMissingOptions: 트랜잭션 중 같은 이름 옵션이 이미 생겼으면(동시 생성) 만들었다고 보고하지 않는다", async () => {
    m(prisma.dbRow.findUnique).mockResolvedValue(row({ "s-title": "작업", "s-status": "s-rev" }));
    // 계획을 세운 뒤(다른 요청이 먼저 커밋해) 트랜잭션 안에서 다시 읽은 config 에는
    // 이미 '검토' 옵션이 있다 — 이번 요청은 그 id 를 재사용해야지 새로 만들면 안 된다.
    tx.dbProperty.findUnique.mockResolvedValue({
      config: { options: [...(tgtProps[1].config.options ?? []), { id: "t-rev-existing", name: "검토", color: "purple" }] },
    });
    const res = await POST(req({ targetDatabaseId: "boardB", createMissingOptions: true }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.createdOptions).toEqual([]);
    expect(tx.dbRow.updateMany.mock.calls[0][0].data.props["t-status"]).toBe("t-rev-existing");
  });

  it("CAS 0건(사이에 수정됨) → 409", async () => {
    tx.dbRow.updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(req({ targetDatabaseId: "boardB" }), params);
    expect(res.status).toBe(409);
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("다른 행이 이 행을 relation 으로 가리키면 referencedBy 로 센다", async () => {
    m(prisma.dbProperty.findMany).mockResolvedValue([
      { id: "dep", databasePageId: "boardA", config: { targetDatabaseId: "boardA" } },
      { id: "other", databasePageId: "boardC", config: { targetDatabaseId: "boardZ" } },
    ]);
    m(prisma.dbRow.findMany).mockResolvedValue([
      { databasePageId: "boardA", props: { dep: ["row1", "x"] } },
      { databasePageId: "boardA", props: { dep: ["x"] } },
    ]);
    const body = await (await POST(req({ targetDatabaseId: "boardB", dryRun: true }), params)).json();
    expect(body.referencedBy).toBe(1);
  });

  it("relation 에 남긴 id 중 대상 보드에 없는 것은 버리고 보고한다", async () => {
    const rel = { type: "relation", config: { targetDatabaseId: "boardX" } };
    m(prisma.dbRow.findUnique).mockResolvedValue({
      ...row({ "s-title": "작업", "s-rel": ["r1", "gone"] }),
      database: { workspaceId: "w1", title: "A", dbProperties: [srcProps[0], { id: "s-rel", name: "관련", ...rel }] },
    });
    m(prisma.page.findUnique).mockResolvedValue({ ...targetPage, dbProperties: [tgtProps[0], { id: "t-rel", name: "관련", ...rel }] });
    m(prisma.dbRow.findMany).mockResolvedValue([{ id: "r1" }]);
    const body = await (await POST(req({ targetDatabaseId: "boardB" }), params)).json();
    expect(tx.dbRow.updateMany.mock.calls[0][0].data.props).toEqual({ "t-title": "작업", "t-rel": ["r1"] });
    expect(body.dropped).toEqual([expect.objectContaining({ name: "관련", value: ["gone"] })]);
    expect(m(prisma.dbRow.findMany).mock.calls[0][0].where).toEqual({ databasePageId: "boardX", id: { in: ["r1", "gone"] } });
  });
});
