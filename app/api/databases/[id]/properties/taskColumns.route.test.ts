import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => fn() }));
vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/pageGuard", () => ({ requirePage: vi.fn(), gatePage: vi.fn() }));
vi.mock("@/lib/taskRows", () => ({ rederiveBoardTaskColumns: vi.fn(async () => 0) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    page: { findUnique: vi.fn() },
    dbProperty: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  },
}));

import { requireCtx } from "@/lib/workspace";
import { requirePage } from "@/lib/pageGuard";
import { rederiveBoardTaskColumns } from "@/lib/taskRows";
import { prisma } from "@/lib/prisma";
import { POST } from "./route";
import { PATCH, DELETE } from "./[propId]/route";

/* 감사 P-14 후속 — 속성 생성·이름 변경·삭제는 상태·담당자 속성 선택(taskColsKey)을 바꿀 수 있어 그 보드 칸을 다시 맞춘다. */
const m = (f: unknown) => f as Mock;
const json = (method: string, body: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const boardParams = { params: Promise.resolve({ id: "b1" }) };
const propParams = { params: Promise.resolve({ id: "b1", propId: "p1" }) };
const prop = { id: "p1", databasePageId: "b1", name: "상태", type: "select", config: { options: [] }, database: { workspaceId: "w1", kind: "database", deletedAt: null } };

describe("보드 속성 쓰기 뒤 태스크 칸 재계산", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor" });
    m(requirePage).mockResolvedValue({ idx: {} });
    m(prisma.page.findUnique).mockResolvedValue({ kind: "database", workspaceId: "w1", deletedAt: null });
    m(prisma.dbProperty.findFirst).mockResolvedValue(null);
    m(prisma.dbProperty.findUnique).mockResolvedValue(prop);
    m(prisma.dbProperty.create).mockResolvedValue({ id: "p2" });
    m(prisma.dbProperty.update).mockResolvedValue(prop);
  });

  it("POST 생성", async () => {
    const res = await POST(new Request("http://t/api/databases/b1/properties", json("POST", { name: "담당자", type: "text" })), boardParams);
    expect(res.status).toBe(200);
    expect(rederiveBoardTaskColumns).toHaveBeenCalledWith("b1");
  });

  it("PATCH 이름 변경", async () => {
    const res = await PATCH(new Request("http://t/x", json("PATCH", { name: "진행 상태" })), propParams);
    expect(res.status).toBe(200);
    expect(rederiveBoardTaskColumns).toHaveBeenCalledWith("b1");
  });

  it("DELETE", async () => {
    expect((await DELETE(new Request("http://t/x", { method: "DELETE" }), propParams)).status).toBe(200);
    expect(rederiveBoardTaskColumns).toHaveBeenCalledWith("b1");
  });

  it("쓰기가 일어나지 않으면(400·404) 돌리지 않는다", async () => {
    expect((await POST(new Request("http://t/x", json("POST", { name: "" })), boardParams)).status).toBe(400);
    expect((await PATCH(new Request("http://t/x", json("PATCH", {})), propParams)).status).toBe(400);
    m(prisma.dbProperty.findUnique).mockResolvedValue(null);
    expect((await DELETE(new Request("http://t/x", { method: "DELETE" }), propParams)).status).toBe(404);
    expect(rederiveBoardTaskColumns).not.toHaveBeenCalled();
  });

  it("재계산이 실패해도 응답은 성공이다(칸이 낡아도 읽기 쪽이 props 로 거른다)", async () => {
    m(rederiveBoardTaskColumns).mockRejectedValueOnce(new Error("db down"));
    expect((await DELETE(new Request("http://t/x", { method: "DELETE" }), propParams)).status).toBe(200);
  });
});
