import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/pageGuard", () => ({ requirePage: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { page: { findFirst: vi.fn() }, dbProperty: { findMany: vi.fn() }, dbRow: { findMany: vi.fn() } },
}));

import { requireCtx } from "@/lib/workspace";
import { requirePage } from "@/lib/pageGuard";
import { prisma } from "@/lib/prisma";
import { GET } from "./route";

const m = (f: unknown) => f as Mock;
const params = { params: Promise.resolve({ id: "b1" }) };
const get = () => GET(new Request("http://t/api/databases/b1/stats"), params);

describe("GET /api/databases/[id]/stats (대시보드 통계, 감사 P-8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "member" });
    m(requirePage).mockResolvedValue({ idx: {} });
    m(prisma.page.findFirst).mockResolvedValue({ id: "b1", title: "태스크" });
    m(prisma.dbProperty.findMany).mockResolvedValue([
      { id: "t", name: "이름", type: "text", config: null },
      { id: "s", name: "상태", type: "select", config: { options: [{ id: "a", name: "할 일", color: "gray" }, { id: "z", name: "완료", color: "green" }] } },
    ]);
    m(prisma.dbRow.findMany).mockResolvedValue([{ id: "r1", props: { t: "가", s: "a" } }, { id: "r2", props: { t: "나", s: "z" } }]);
  });

  it("보드 제목·통계만 돌려준다(행 원본 없음)", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.page).toEqual({ id: "b1", title: "태스크" });
    expect(j.stats.total).toBe(2);
    expect(j.stats.status.done).toEqual({ name: "완료", count: 1 });
    expect(j).not.toHaveProperty("rows");
    // 행은 id·props 만 읽는다
    expect(m(prisma.dbRow.findMany).mock.calls[0][0]).toMatchObject({ where: { databasePageId: "b1" }, select: { id: true, props: true } });
  });

  it("D3 게이트에 막히면 그 응답 그대로", async () => {
    m(requirePage).mockResolvedValue({ err: new Response("no", { status: 404 }) });
    expect((await get()).status).toBe(404);
    expect(prisma.dbRow.findMany).not.toHaveBeenCalled();
  });

  it("보드가 아니거나 다른 워크스페이스·삭제됨이면 404", async () => {
    m(prisma.page.findFirst).mockResolvedValue(null);
    expect((await get()).status).toBe(404);
    expect(m(prisma.page.findFirst).mock.calls[0][0].where).toEqual({ id: "b1", workspaceId: "w1", kind: "database", deletedAt: null });
  });
});
