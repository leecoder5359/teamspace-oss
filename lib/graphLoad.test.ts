import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/pageGuard", () => ({ loadAccess: vi.fn(), visibleOnly: vi.fn() }));
vi.mock("@/lib/pageAccess", () => ({ pageAccess: vi.fn(), projectAccess: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    page: { findMany: vi.fn() },
    project: { findMany: vi.fn() },
    decision: { findMany: vi.fn() },
    lesson: { findMany: vi.fn() },
    risk: { findMany: vi.fn() },
    dbRow: { findMany: vi.fn() },
    dbProperty: { findMany: vi.fn() },
    graphEdge: { findMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/prisma";
import { loadAccess, visibleOnly } from "@/lib/pageGuard";
import { pageAccess, projectAccess } from "@/lib/pageAccess";
import { loadGraph, invalidateGraphCache, GRAPH_CACHE_TTL_MS, __graphCacheSizes } from "./graphLoad";

const m = (f: unknown) => f as Mock;
const ctx = { workspaceId: "w1", userId: "u1", role: "member" } as never;
const ID = (n: string) => `c${n.padEnd(24, "0")}`;
const HIDDEN = ID("hid");
const HIDDEN_PROJ = ID("hproj");

describe("loadGraph — 권한(D3)", () => {
  beforeEach(() => {
    invalidateGraphCache();
    vi.resetAllMocks();
    m(loadAccess).mockResolvedValue({});
    m(visibleOnly).mockImplementation((_i: unknown, rows: { id: string }[]) => rows.filter((r) => r.id !== HIDDEN));
    m(pageAccess).mockImplementation((_i: unknown, id: string) => (id === HIDDEN || id === ID("hboard") ? "none" : "view"));
    m(projectAccess).mockImplementation((_i: unknown, id: string) => (id === HIDDEN_PROJ ? "none" : "view"));
    m(prisma.page.findMany).mockResolvedValue([
      { id: ID("a"), title: "보이는 문서", markdown: `[[숨은 문서 제목]] ${HIDDEN}`, parentId: null, projectId: null },
      { id: HIDDEN, title: "숨은 문서 제목", markdown: `${ID("a")}`, parentId: null, projectId: null },
    ]);
    m(prisma.project.findMany).mockResolvedValue([{ id: HIDDEN_PROJ, name: "숨은 프로젝트" }]);
    m(prisma.decision.findMany).mockResolvedValue([
      { id: ID("d1"), title: "보이는 결정", context: `${ID("a")}`, decision: null, projectId: null },
      { id: ID("d2"), title: "숨은 프로젝트 결정", context: `${ID("a")}`, decision: null, projectId: HIDDEN_PROJ },
    ]);
    m(prisma.lesson.findMany).mockResolvedValue([]);
    m(prisma.risk.findMany).mockResolvedValue([]);
    m(prisma.dbRow.findMany).mockResolvedValue([
      { id: ID("t1"), databasePageId: ID("hboard"), contentPageId: ID("a"), props: {} },
    ]);
    m(prisma.dbProperty.findMany).mockResolvedValue([]);
    m(prisma.graphEdge.findMany).mockResolvedValue([{ fromId: ID("a"), toId: HIDDEN, kind: "related" }]);
  });

  it("볼 수 없는 문서·프로젝트·결정·보드 태스크는 노드에도 간선에도 없다", async () => {
    const g = await loadGraph(ctx);
    const ids = new Set(g.nodes.map((n) => n.id));
    expect(ids.has(HIDDEN)).toBe(false);
    expect(ids.has(HIDDEN_PROJ)).toBe(false);
    expect(ids.has(ID("d2"))).toBe(false);
    expect(ids.has(ID("t1"))).toBe(false);
    expect(JSON.stringify(g)).not.toContain(HIDDEN);
    expect(JSON.stringify(g)).not.toContain("숨은");
    expect(ids.has(ID("d1"))).toBe(true);
  });

  it("전달받은 access 색인이 있으면 다시 읽지 않는다", async () => {
    await loadGraph(ctx, {} as never);
    expect(loadAccess).not.toHaveBeenCalled();
  });

  it("보이는 보드 태스크의 contentPageId 가 숨은 문서면 href 는 보드로 폴백하고 id 가 새지 않는다", async () => {
    m(prisma.dbRow.findMany).mockResolvedValue([
      { id: ID("t2"), databasePageId: ID("vboard"), contentPageId: HIDDEN, props: { x: `see ${ID("a")}` } },
    ]);
    const g = await loadGraph(ctx);
    const t = g.nodes.find((n) => n.id === ID("t2"));
    expect(t).toBeDefined();
    expect(t!.href).toBe(`/p/${ID("vboard")}`);
    expect(JSON.stringify(g)).not.toContain(HIDDEN);
  });

  it("보이는 문서의 projectId 가 접근 불가 프로젝트면 노드 projectId 는 null", async () => {
    m(prisma.page.findMany).mockResolvedValue([
      { id: ID("a"), title: "보이는 문서", markdown: "", parentId: null, projectId: HIDDEN_PROJ },
    ]);
    const g = await loadGraph(ctx);
    expect(g.nodes.find((n) => n.id === ID("a"))).toBeDefined();
    expect(JSON.stringify(g)).not.toContain(HIDDEN_PROJ);
  });

  it("보이는 보드 태스크 props 의 숨은 id 는 출력에 나오지 않는다", async () => {
    m(prisma.dbRow.findMany).mockResolvedValue([
      { id: ID("t3"), databasePageId: ID("vboard"), contentPageId: null, props: { rel: [HIDDEN], y: ID("a") } },
    ]);
    const g = await loadGraph(ctx);
    expect(g.nodes.find((n) => n.id === ID("t3"))).toBeDefined();
    expect(JSON.stringify(g)).not.toContain(HIDDEN);
  });

  it("보이는 두 문서 사이의 저장된 related 간선은 유지된다(양성 대조)", async () => {
    m(prisma.page.findMany).mockResolvedValue([
      { id: ID("a"), title: "A", markdown: "", parentId: null, projectId: null },
      { id: ID("b"), title: "B", markdown: "", parentId: null, projectId: null },
    ]);
    m(prisma.graphEdge.findMany).mockResolvedValue([{ fromId: ID("a"), toId: ID("b"), kind: "related" }]);
    const g = await loadGraph(ctx);
    const e = g.edges.find((x) => [x.from, x.to].includes(ID("a")) && [x.from, x.to].includes(ID("b")));
    expect(e?.kind).toBe("related");
    expect(e?.tag).toBe("모호");
  });

  it("ceiling none 이면 쿼리 없이 빈 그래프", async () => {
    m(loadAccess).mockResolvedValue({ ceiling: "none" });
    const g = await loadGraph(ctx);
    expect(g).toEqual({ nodes: [], edges: [] });
    expect(prisma.page.findMany).not.toHaveBeenCalled();
  });
});

describe("loadGraph — 뷰어별 TTL 캐시", () => {
  beforeEach(() => {
    invalidateGraphCache();
    vi.resetAllMocks();
    vi.useRealTimers();
    m(loadAccess).mockResolvedValue({});
    m(visibleOnly).mockImplementation((_i: unknown, rows: unknown[]) => rows);
    m(pageAccess).mockReturnValue("view");
    m(projectAccess).mockReturnValue("view");
    m(prisma.page.findMany).mockResolvedValue([{ id: ID("a"), title: "문서 에이", markdown: "", parentId: null, projectId: null }]);
    for (const f of [prisma.project, prisma.decision, prisma.lesson, prisma.risk, prisma.dbRow, prisma.dbProperty, prisma.graphEdge]) {
      m(f.findMany).mockResolvedValue([]);
    }
  });

  it("같은 권한 두 번: DB 는 한 번, 완성 그래프 재사용(권한 색인은 매번 계산)", async () => {
    const a = await loadGraph(ctx);
    const b = await loadGraph(ctx);
    expect(b).toEqual(a);
    expect(b.nodes[0]).toBe(a.nodes[0]); // buildGraph 결과 객체 그대로
    expect(prisma.page.findMany).toHaveBeenCalledTimes(1);
    expect(loadAccess).toHaveBeenCalledTimes(2);
  });

  it("TTL 안에서 권한이 회수되면 다음 호출에 즉시 빠진다(완성 캐시를 쓰지 않음)", async () => {
    m(prisma.page.findMany).mockResolvedValue([
      { id: ID("a"), title: "문서 에이", markdown: "문서 비이 상세 참고", parentId: null, projectId: null },
      { id: ID("b"), title: "문서 비이 상세", markdown: "", parentId: null, projectId: null },
    ]);
    const a = await loadGraph(ctx);
    expect(a.nodes.map((n) => n.id)).toContain(ID("b"));
    expect(a.edges).toHaveLength(1);
    m(visibleOnly).mockImplementation((_i: unknown, rows: { id: string }[]) => rows.filter((r) => r.id !== ID("b")));
    const b = await loadGraph(ctx);
    expect(b.nodes.map((n) => n.id)).toEqual([ID("a")]);
    expect(b.edges).toHaveLength(0);
    expect(JSON.stringify(b)).not.toContain("비이");
    expect(b.nodes[0]).not.toBe(a.nodes[0]); // 새로 만든 그래프
    expect(prisma.page.findMany).toHaveBeenCalledTimes(1); // 원시 행은 캐시
  });

  it("태스크 본문 문서 접근만 회수돼도 지문이 바뀐다", async () => {
    m(prisma.dbRow.findMany).mockResolvedValue([{ id: ID("t1"), databasePageId: ID("vb"), contentPageId: ID("a"), props: {} }]);
    const a = await loadGraph(ctx);
    expect(a.nodes.find((n) => n.id === ID("t1"))?.href).toBe(`/p/${ID("a")}`);
    m(pageAccess).mockImplementation((_i: unknown, id: string) => (id === ID("a") ? "none" : "view"));
    const b = await loadGraph(ctx);
    expect(b.nodes.find((n) => n.id === ID("t1"))).toBeUndefined(); // 간선 없는 태스크는 노드에서 빠짐
  });

  it("access 를 넘기면 loadAccess 없이 같은 캐시를 쓴다", async () => {
    await loadGraph(ctx, {} as never);
    await loadGraph(ctx, {} as never);
    expect(prisma.page.findMany).toHaveBeenCalledTimes(1);
    expect(loadAccess).not.toHaveBeenCalled();
  });

  it("원시 행은 워크스페이스별, 권한 색인은 뷰어별", async () => {
    await loadGraph(ctx);
    await loadGraph({ workspaceId: "w1", userId: "u2", role: "member" } as never);
    await loadGraph({ workspaceId: "w2", userId: "u1", role: "member" } as never);
    expect(prisma.page.findMany).toHaveBeenCalledTimes(2);
    expect(loadAccess).toHaveBeenCalledTimes(3);
  });

  it("invalidateGraphCache(워크스페이스) 는 그 워크스페이스만 비운다", async () => {
    const other = { workspaceId: "w2", userId: "u1", role: "member" } as never;
    await loadGraph(ctx);
    await loadGraph(other);
    invalidateGraphCache("w1");
    await loadGraph(ctx);
    await loadGraph(other);
    expect(prisma.page.findMany).toHaveBeenCalledTimes(3);
    invalidateGraphCache();
    await loadGraph(other);
    expect(prisma.page.findMany).toHaveBeenCalledTimes(4);
  });

  it("TTL 이 지나면 다시 읽는다", async () => {
    vi.useFakeTimers();
    await loadGraph(ctx);
    vi.advanceTimersByTime(GRAPH_CACHE_TTL_MS - 1);
    await loadGraph(ctx);
    expect(prisma.page.findMany).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2);
    await loadGraph(ctx);
    expect(prisma.page.findMany).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("캐시된 그래프를 호출자가 바꿔도 다음 결과는 오염되지 않는다", async () => {
    const a = await loadGraph(ctx);
    a.nodes.length = 0;
    const b = await loadGraph(ctx);
    expect(b.nodes).toHaveLength(1);
  });

  it("TTL 만료 뒤 다시 읽으면 낡은 세대의 완성 캐시는 정리되고, 다른 워크스페이스의 만료 원시 항목도 쓸려난다", async () => {
    vi.useFakeTimers();
    const other = { workspaceId: "w2", userId: "u1", role: "member" } as never;
    await loadGraph(ctx);
    await loadGraph(other);
    expect(__graphCacheSizes()).toEqual({ raw: 2, built: 2 });
    vi.advanceTimersByTime(GRAPH_CACHE_TTL_MS + 1);
    await loadGraph(ctx);
    expect(__graphCacheSizes()).toEqual({ raw: 1, built: 1 });
    vi.useRealTimers();
  });
});
