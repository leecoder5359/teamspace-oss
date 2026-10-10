import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: { page: { findUnique: vi.fn(), updateMany: vi.fn() } } }));
vi.mock("@/lib/pageGuard", () => ({ isRestrictedPage: vi.fn() }));
vi.mock("@/lib/graphLoad", () => ({ invalidateGraphCache: vi.fn() }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/notify", () => ({ fireNotif: vi.fn() }));

import { trashPage, patchPageMeta } from "./pageService";
import { prisma } from "@/lib/prisma";
import { invalidateGraphCache } from "@/lib/graphLoad";

const guard = { workspaceId: "w1", userId: "u1", role: "editor" as const, actor: { type: "user" as const, id: "u1", name: "U" } };
const findUnique = prisma.page.findUnique as unknown as Mock;

describe("pageService", () => {
  beforeEach(() => vi.resetAllMocks());

  it("trashPage: 살아 있는 자식이 있고 recursive 가 아니면 ok:false 409 — 삭제·무효화 없음", async () => {
    findUnique.mockResolvedValue({ id: "p1", workspaceId: "w1", deletedAt: null, kind: "doc", title: "T", children: [{ deletedAt: null }] });
    const r = await trashPage(guard, "p1", { recursive: false });
    expect(r).toEqual({ ok: false, status: 409, error: "Has children" });
    expect(prisma.page.updateMany).not.toHaveBeenCalled();
    expect(invalidateGraphCache).not.toHaveBeenCalled();
  });

  it("patchPageMeta: 페이지가 없으면 본문이 잘못돼도 404 가 먼저(원래 라우트 순서)", async () => {
    findUnique.mockResolvedValue(null);
    expect(await patchPageMeta(guard, "p1", { title: 123 })).toEqual({ ok: false, status: 404, error: "Not found" });
  });
});
