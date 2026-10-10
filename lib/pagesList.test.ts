import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/pageGuard", () => ({ loadAccess: vi.fn(), visibleOnly: vi.fn(), projectAccess: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { page: { findMany: vi.fn() }, project: { findMany: vi.fn() }, pageFavorite: { findMany: vi.fn() } },
}));

import { prisma } from "@/lib/prisma";
import { loadAccess, visibleOnly, projectAccess } from "@/lib/pageGuard";
import { listPagesForSidebar, listProjectsForSidebar } from "./pagesList";

const m = (f: unknown) => f as Mock;
const ctx = { workspaceId: "w1", userId: "u1", role: "editor" as const, actor: { type: "user" as const, id: "u1", name: "U" } };
const at = new Date("2026-10-09T01:02:03.000Z");
const row = (id: string, parentId: string | null, extra: Record<string, unknown> = {}) => ({
  id, title: id.toUpperCase(), icon: null, parentId, position: 0, kind: "doc", projectId: "pr1", updatedAt: at, visibility: "inherit", docType: null, ...extra,
});

describe("listPagesForSidebar", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(loadAccess).mockResolvedValue({});
    m(visibleOnly).mockImplementation((_i: unknown, rows: { id: string }[]) => rows.filter((r) => r.id !== "hidden"));
    m(prisma.page.findMany).mockResolvedValue([row("a", null), row("b", "a", { visibility: "restricted" }), row("c", "b"), row("hidden", null)]);
    m(prisma.project.findMany).mockResolvedValue([{ id: "pr1", visibility: "inherit" }]);
    m(prisma.pageFavorite.findMany).mockResolvedValue([{ pageId: "c" }]);
  });

  it("GET /api/pages 와 같은 필드 — 트리 메타·잠금 표시·ISO 문자열 updatedAt", async () => {
    const out = await listPagesForSidebar(ctx);
    expect(out.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(out[0]).toEqual({
      id: "a", title: "A", icon: null, parentId: null, position: 0, kind: "doc", projectId: "pr1",
      updatedAt: "2026-10-09T01:02:03.000Z", visibility: "inherit", docType: null,
      childCount: 1, isFavorite: false, restricted: false, restrictedSelf: false,
    });
    expect(out[1]).toMatchObject({ restricted: true, restrictedSelf: true, childCount: 1 });
    expect(out[2]).toMatchObject({ restricted: true, restrictedSelf: false, isFavorite: true });
  });

  it("JSON 왕복과 같은 모양이다(서버 주입 ↔ 클라 fetch 동일)", async () => {
    const out = await listPagesForSidebar(ctx);
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  it("삭제 제외·부모/위치 순서·내 즐겨찾기만 조회한다", async () => {
    await listPagesForSidebar(ctx);
    expect(m(prisma.page.findMany).mock.calls[0][0]).toMatchObject({
      where: { workspaceId: "w1", deletedAt: null },
      orderBy: [{ parentId: "asc" }, { position: "asc" }],
    });
    expect(m(prisma.pageFavorite.findMany).mock.calls[0][0]).toMatchObject({ where: { userId: "u1" } });
  });
});

describe("보관(F2) — 조상 기반", () => {
  // a(보관) ─ b ─ c(자식의 자식), d 는 별개 활성, e(스스로 보관) 는 활성 부모 d 아래
  beforeEach(() => {
    vi.resetAllMocks();
    m(loadAccess).mockResolvedValue({});
    m(visibleOnly).mockImplementation((_i: unknown, rows: unknown[]) => rows);
    m(prisma.page.findMany).mockResolvedValue([
      row("a", null, { archivedAt: at }), row("b", "a", { archivedAt: null }), row("c", "b", { archivedAt: null }),
      row("d", null, { archivedAt: null }), row("e", "d", { archivedAt: at }),
    ]);
    m(prisma.project.findMany).mockResolvedValue([]);
    m(prisma.pageFavorite.findMany).mockResolvedValue([]);
  });

  it("조회는 archivedAt 로 거르지 않는다(조상 판정에 전체 트리 필요)", async () => {
    await listPagesForSidebar(ctx);
    expect(m(prisma.page.findMany).mock.calls[0][0].where).not.toHaveProperty("archivedAt");
  });
  it("기본(active): 보관한 문서와 그 하위가 모두 빠지고 archived·archivedAt 필드 없음, childCount 도 활성만", async () => {
    const out = await listPagesForSidebar(ctx);
    expect(out.map((p) => p.id)).toEqual(["d"]);
    expect(out[0].childCount).toBe(0);
    expect(out.every((p) => !("archived" in p) && !("archivedAt" in p))).toBe(true);
  });
  it("only: 스스로 보관한 문서(루트)만 — 하위는 보관함에 나오지 않는다", async () => {
    const out = await listPagesForSidebar(ctx, undefined, { archived: "only" });
    expect(out.map((p) => p.id).sort()).toEqual(["a", "e"]);
    expect(out.every((p) => p.archived === true && !("archivedAt" in p))).toBe(true);
  });
  it("all: 전부 — 보관 집합(하위 포함)에만 archived:true", async () => {
    const out = await listPagesForSidebar(ctx, undefined, { archived: "all" });
    expect(out.map((p) => p.id).sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(out.filter((p) => p.archived).map((p) => p.id).sort()).toEqual(["a", "b", "c", "e"]);
    expect(out.find((p) => p.id === "d")).not.toHaveProperty("archived");
  });
  it("보관된 부모의 잠금은 active 에서도 계산에 쓰인다(자식이 빠져도 나머지 계산이 어긋나지 않음)", async () => {
    m(prisma.page.findMany).mockResolvedValue([
      row("a", null, { archivedAt: at, visibility: "restricted" }), row("b", "a"), row("d", null),
    ]);
    const out = await listPagesForSidebar(ctx, undefined, { archived: "all" });
    expect(out.find((p) => p.id === "b")).toMatchObject({ restricted: true, restrictedSelf: false, archived: true });
  });
});

describe("access 인덱스 공유", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(visibleOnly).mockImplementation((_i: unknown, rows: unknown[]) => rows);
    m(projectAccess).mockReturnValue("edit");
    m(prisma.page.findMany).mockResolvedValue([row("a", null)]);
    m(prisma.project.findMany).mockResolvedValue([{ id: "pr1", visibility: "inherit", name: "P" }]);
    m(prisma.pageFavorite.findMany).mockResolvedValue([]);
  });

  it("access 를 넘기면 loadAccess 를 부르지 않는다", async () => {
    const access = {} as never;
    await listPagesForSidebar(ctx, access);
    await listProjectsForSidebar(ctx, access);
    expect(m(loadAccess)).not.toHaveBeenCalled();
    expect(m(visibleOnly).mock.calls[0][0]).toBe(access);
  });

  it("넘기지 않으면 loadAccess 를 부른다", async () => {
    m(loadAccess).mockResolvedValue({});
    await listPagesForSidebar(ctx);
    expect(m(loadAccess)).toHaveBeenCalledTimes(1);
  });
});

describe("listProjectsForSidebar", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(loadAccess).mockResolvedValue({});
    m(projectAccess).mockImplementation((_i: unknown, id: string) => (id === "locked" ? "none" : "edit"));
    m(prisma.project.findMany).mockResolvedValue([
      { id: "p1", name: "One", archivedAt: null }, { id: "locked", name: "Secret", archivedAt: null }, { id: "p2", name: "Two", archivedAt: new Date() },
    ]);
  });

  it("/api/projects 와 같은 순서(position asc)·잠긴 프로젝트 제외·id/name/archived 만", async () => {
    const out = await listProjectsForSidebar(ctx);
    expect(m(prisma.project.findMany).mock.calls[0][0]).toMatchObject({ where: { workspaceId: "w1" }, orderBy: { position: "asc" } });
    // 보관 프로젝트도 남긴다(archived 표시만) — 빼면 그 페이지가 미분류로 떨어진다(F10)
    expect(out).toEqual([{ id: "p1", name: "One", archived: false }, { id: "p2", name: "Two", archived: true }]);
  });
});
