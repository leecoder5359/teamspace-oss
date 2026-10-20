import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/pageGuard", () => ({ requirePage: vi.fn() }));
vi.mock("@/lib/relationServer", () => ({ validateRelationProps: vi.fn(async (_b: string, props: unknown) => ({ ok: true, props })) }));
vi.mock("@/lib/notify", () => ({ notifyTaskCreated: vi.fn() }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/idempotency", () => ({ withIdempotency: (_r: Request, _g: unknown, fn: () => Promise<Response>) => fn() }));
vi.mock("@/lib/graphLoad", () => ({ invalidateGraphCache: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { page: { findUnique: vi.fn() }, dbRow: { findFirst: vi.fn(), create: vi.fn() }, dbProperty: { findMany: vi.fn(async () => []) } },
}));

import { requireCtx } from "@/lib/workspace";
import { requirePage } from "@/lib/pageGuard";
import { invalidateGraphCache } from "@/lib/graphLoad";
import { prisma } from "@/lib/prisma";
import { POST } from "./route";

/* 새 태스크는 그래프 노드다 — 원시 그래프가 SWR 로 최대 10분 낡으니 생성 뒤 비운다. */
const m = (f: unknown) => f as Mock;
const params = { params: Promise.resolve({ id: "b1" }) };
const post = (body: unknown) => POST(new Request("http://t/api/databases/b1/rows", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), params);

describe("POST /api/databases/[id]/rows 그래프 캐시", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor", actor: { type: "user", id: "u1", name: "U" } });
    m(requirePage).mockResolvedValue({ idx: {} });
    m(prisma.page.findUnique).mockResolvedValue({ kind: "database", workspaceId: "w1", deletedAt: null });
    m(prisma.dbRow.findFirst).mockResolvedValue(null);
    m(prisma.dbRow.create).mockResolvedValue({ id: "r1" });
  });

  it("행을 만들면 비운다", async () => {
    expect((await post({ props: { t: "작업" } })).status).toBe(200);
    expect(invalidateGraphCache).toHaveBeenCalledWith("w1");
  });

  it("보드가 아니면(404) 비우지 않는다", async () => {
    m(prisma.page.findUnique).mockResolvedValue({ kind: "doc", workspaceId: "w1", deletedAt: null });
    expect((await post({})).status).toBe(404);
    expect(invalidateGraphCache).not.toHaveBeenCalled();
  });
});

describe("POST /api/databases/[id]/rows 비정규화 칸(감사 P-14)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor", actor: { type: "user", id: "u1", name: "U" } });
    m(requirePage).mockResolvedValue({ idx: {} });
    m(prisma.page.findUnique).mockResolvedValue({ kind: "database", workspaceId: "w1", deletedAt: null });
    m(prisma.dbRow.findFirst).mockResolvedValue(null);
    m(prisma.dbRow.create).mockResolvedValue({ id: "r1" });
  });

  it("만들 때 상태 옵션 id·담당자·키를 함께 쓴다", async () => {
    m(prisma.dbProperty.findMany).mockResolvedValue([
      { id: "t", name: "제목", type: "text", config: {} },
      { id: "s", name: "상태", type: "select", config: { options: [{ id: "o1", name: "할 일" }] } },
      { id: "a", name: "담당자", type: "text", config: {} },
    ]);
    await post({ props: { t: "작업", s: "o1", a: " 이준 " } });
    expect(m(prisma.dbRow.create).mock.calls[0][0].data).toMatchObject({ statusOptionId: "o1", assigneeText: "이준", taskColsKey: "s|a" });
  });
});
