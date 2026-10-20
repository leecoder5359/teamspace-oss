import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/pageGuard", () => ({ loadAccess: vi.fn(async () => ({})), pageAccess: vi.fn(() => "edit") }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    page: { findMany: vi.fn() },
    dbProperty: { findMany: vi.fn() },
    dbRow: { findMany: vi.fn() },
  },
}));

import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { GET } from "./route";

const m = (f: unknown) => f as Mock;
const STATUSES = ["할 일", "진행 중", "완료"];
const props = [
  { id: "pt", type: "text", name: "제목", config: {} },
  { id: "ps", type: "select", name: "상태", config: { options: STATUSES.map((n, i) => ({ id: `o${i}`, name: n })) } },
];
// 120 open + 10 closed
const rows = Array.from({ length: 130 }, (_, i) => ({
  id: `r${i}`,
  props: { pt: `t${i}`, ps: i < 120 ? `o${i % 2}` : "o2" },
  createdAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000),
  updatedAt: new Date(Date.UTC(2026, 0, 1) - i * 60_000),
}));
/** DbRow where 의 부분집합(이 라우트가 쓰는 것)을 메모리에서 평가 — 칸이 채워진 행·안 채워진 행을 함께 시험한다. */
type W = Record<string, unknown>;
const matches = (r: W, w: W): boolean =>
  Object.entries(w).every(([k, v]) => {
    if (k === "OR") return (v as W[]).some((x) => matches(r, x));
    if (k === "databasePageId") return true;
    const cur = (r[k] ?? null) as string | null;
    if (v === null) return cur === null;
    if (typeof v === "object" && v && "notIn" in v) return cur !== null && !(v.notIn as string[]).includes(cur);
    if (typeof v === "object" && v && "not" in v) return cur !== null && cur !== v.not;
    return cur === v;
  });
const store = (all: W[]) => async ({ where }: { where: W }) => all.filter((r) => matches(r, where));
const get = (qs = "") => GET(new Request(`http://t/api/tasks${qs}`)).then((r) => r.json());

describe("GET /api/tasks 파라미터 파싱", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", role: "editor", actor: { type: "user", id: "u", name: "U" } });
    m(prisma.page.findMany).mockResolvedValue([{ id: "db1" }]);
    m(prisma.dbProperty.findMany).mockResolvedValue(props);
    m(prisma.dbRow.findMany).mockImplementation(store(rows)); // 칸 없음(백필 전) — 전부 낡은 쪽으로 온다
  });

  it("기본(status 생략)=open·limit 50, total 은 필터 후 전체", async () => {
    const r = await get();
    expect(r.total).toBe(120);
    expect(r.shown).toBe(50);
  });
  it("status=all 은 닫힌 것까지", async () => {
    const r = await get("?status=all&limit=200");
    expect(r.total).toBe(130);
    expect(r.shown).toBe(130);
  });
  it("status=open 및 알 수 없는 이름은 open 으로 취급", async () => {
    expect((await get("?status=open")).total).toBe(120);
    expect((await get("?status=완료")).total).toBe(120);
  });
  it("limit=all 은 상한 없이 전부", async () => {
    const r = await get("?limit=all");
    expect(r.shown).toBe(120);
  });
  it("limit=abc·limit=0·음수는 기본 50, 9999 는 200 상한", async () => {
    expect((await get("?limit=abc")).shown).toBe(50);
    expect((await get("?limit=0")).shown).toBe(50);
    expect((await get("?limit=-3")).shown).toBe(50);
    expect((await get("?status=all&limit=9999")).shown).toBe(130);
    expect((await get("?limit=7")).shown).toBe(7);
  });
});

describe("GET /api/tasks q·sort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", role: "editor", actor: { type: "user", id: "u", name: "U" } });
    m(prisma.page.findMany).mockResolvedValue([{ id: "db1" }]);
    m(prisma.dbProperty.findMany).mockResolvedValue(props);
    m(prisma.dbRow.findMany).mockImplementation(store(rows)); // 칸 없음(백필 전) — 전부 낡은 쪽으로 온다
  });

  it("q 는 limit 앞에 적용되고 total 에 반영", async () => {
    const r = await get("?q=T11&limit=5");
    // t11, t110..t119 = 11건(모두 open)
    expect(r.total).toBe(11);
    expect(r.shown).toBe(5);
  });
  it("sort=created 는 최신 생성 먼저 — 보드 끝 행이 첫 페이지에 온다", async () => {
    const r = await get("?sort=created&limit=3");
    expect(r.tasks.map((t: { id: string }) => t.id)).toEqual(["r119", "r118", "r117"]);
    expect(r.total).toBe(120);
  });
  it("sort=updated 는 최신 수정 먼저", async () => {
    const r = await get("?sort=updated&limit=2");
    expect(r.tasks.map((t: { id: string }) => t.id)).toEqual(["r0", "r1"]);
  });
  it("sort 생략은 position 순서 그대로", async () => {
    const r = await get("?limit=2");
    expect(r.tasks.map((t: { id: string }) => t.id)).toEqual(["r0", "r1"]);
  });
  it("알 수 없는 sort 는 400", async () => {
    const res = await GET(new Request("http://t/api/tasks?sort=newest"));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/tasks 비정규화 칸(감사 P-14)", () => {
  const props2 = [...props, { id: "pa", type: "text", name: "담당자", config: {} }];
  const KEY = "ps|pa";
  const keyed = (id: string, ps: string, pa: string | null, position: number) => ({
    id, position, props: { pt: id, ps, ...(pa ? { pa } : {}) }, statusOptionId: ps, assigneeText: pa, taskColsKey: KEY,
    createdAt: new Date(0), updatedAt: new Date(0),
  });
  const stale = (id: string, ps: string, pa: string | null, position: number) => ({ ...keyed(id, ps, pa, position), statusOptionId: null, assigneeText: null, taskColsKey: null });

  beforeEach(() => {
    vi.clearAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", role: "editor", actor: { type: "user", id: "u", name: "U" } });
    m(prisma.page.findMany).mockResolvedValue([{ id: "db1" }]);
    m(prisma.dbProperty.findMany).mockResolvedValue(props2);
  });

  it("열린 것만: 닫힌 옵션 id 를 DB 조건으로 넘기고, 칸 있는 행·없는 행을 position 순으로 합친다", async () => {
    m(prisma.dbRow.findMany).mockImplementation(store([keyed("a", "o0", null, 0), keyed("done", "o2", null, 1), stale("b", "o1", null, 2), stale("oldDone", "o2", null, 3)]));
    const r = await get();
    expect(r.tasks.map((t: { id: string }) => t.id)).toEqual(["a", "b"]);
    const fast = m(prisma.dbRow.findMany).mock.calls[0][0].where;
    expect(fast).toMatchObject({ databasePageId: "db1", taskColsKey: KEY, OR: [{ statusOptionId: null }, { statusOptionId: { notIn: ["o2"] } }] });
  });

  it("보드 속성은 쓰는 쪽·백필과 같은 순서(position, id)로 읽는다 — 동률이어도 키가 어긋나지 않게", async () => {
    m(prisma.dbRow.findMany).mockImplementation(store([]));
    await get();
    expect(m(prisma.dbProperty.findMany).mock.calls[0][0].orderBy).toEqual([{ position: "asc" }, { id: "asc" }]);
  });

  it("assignee=me 는 assigneeText 조건으로", async () => {
    m(prisma.dbRow.findMany).mockImplementation(store([keyed("mine", "o0", "U", 0), keyed("theirs", "o0", "V", 1), stale("oldMine", "o0", "U", 2)]));
    const r = await get("?assignee=me");
    expect(r.tasks.map((t: { id: string }) => t.id)).toEqual(["mine", "oldMine"]);
    expect(m(prisma.dbRow.findMany).mock.calls[0][0].where.assigneeText).toBe("U");
  });

  it("status=all·담당자 거름 없음이면 예전처럼 보드 전체를 한 번 읽는다", async () => {
    m(prisma.dbRow.findMany).mockImplementation(store([keyed("a", "o0", null, 0), keyed("done", "o2", null, 1)]));
    const r = await get("?status=all");
    expect(r.total).toBe(2);
    expect(m(prisma.dbRow.findMany).mock.calls).toEqual([[{ where: { databasePageId: "db1" }, orderBy: { position: "asc" } }]]);
  });

  it("속성이 바뀌어 키가 달라진 행은 칸을 믿지 않는다(낡은 쪽으로 와서 JS 로 거른다)", async () => {
    const changed = { ...keyed("wasKeyed", "o0", null, 0), taskColsKey: "old|", statusOptionId: "o2" }; // 칸은 '완료' 라고 하지만 키가 다르다
    m(prisma.dbRow.findMany).mockImplementation(store([changed]));
    const r = await get();
    expect(r.tasks.map((t: { id: string }) => t.id)).toEqual(["wasKeyed"]); // props 의 o0(할 일) 기준으로 열린 것
  });
});
