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
const get = (qs = "") => GET(new Request(`http://t/api/tasks${qs}`)).then((r) => r.json());

describe("GET /api/tasks 파라미터 파싱", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", role: "editor", actor: { type: "user", id: "u", name: "U" } });
    m(prisma.page.findMany).mockResolvedValue([{ id: "db1" }]);
    m(prisma.dbProperty.findMany).mockResolvedValue(props);
    m(prisma.dbRow.findMany).mockResolvedValue(rows);
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
    m(prisma.dbRow.findMany).mockResolvedValue(rows);
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
