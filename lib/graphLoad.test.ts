import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
    graphCacheGen: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

import { prisma } from "@/lib/prisma";
import { loadAccess, visibleOnly } from "@/lib/pageGuard";
import { pageAccess, projectAccess } from "@/lib/pageAccess";
import { loadGraph, invalidateGraphCache, rowPatchTouchesGraph, GRAPH_CACHE_TTL_MS, GRAPH_CACHE_MAX_STALE_MS, GRAPH_GEN_CHECK_MS, __graphCacheSizes } from "./graphLoad";

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
    vi.advanceTimersByTime(GRAPH_CACHE_MAX_STALE_MS + 1);
    await loadGraph(ctx);
    expect(__graphCacheSizes()).toEqual({ raw: 1, built: 1 });
    vi.useRealTimers();
  });
});

describe("loadGraph — stale-while-revalidate", () => {
  const page = (title: string) => [{ id: ID("a"), title, markdown: "", parentId: null, projectId: null }];
  const titles = (g: { nodes: { label?: string; title?: string }[] }) => JSON.stringify(g.nodes);
  const flush = () => new Promise<void>((r) => setImmediate(r));
  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
  };

  beforeEach(() => {
    invalidateGraphCache();
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    m(loadAccess).mockResolvedValue({});
    m(visibleOnly).mockImplementation((_i: unknown, rows: unknown[]) => rows);
    m(pageAccess).mockReturnValue("view");
    m(projectAccess).mockReturnValue("view");
    for (const f of [prisma.project, prisma.decision, prisma.lesson, prisma.risk, prisma.dbRow, prisma.dbProperty, prisma.graphEdge]) {
      m(f.findMany).mockResolvedValue([]);
    }
  });

  it("만료됐지만 resolve 된 항목은 즉시 돌려주고 백그라운드로 한 번만 다시 읽는다", async () => {
    m(prisma.page.findMany).mockResolvedValueOnce(page("옛 제목"));
    await loadGraph(ctx);
    const next = deferred<unknown>();
    m(prisma.page.findMany).mockReturnValueOnce(next.promise);
    vi.advanceTimersByTime(GRAPH_CACHE_TTL_MS + 1);
    const [a, b, c] = await Promise.all([loadGraph(ctx), loadGraph(ctx), loadGraph(ctx)]);
    for (const g of [a, b, c]) expect(titles(g)).toContain("옛 제목");
    expect(prisma.page.findMany).toHaveBeenCalledTimes(2); // 진행 중 재로드는 하나
    next.resolve(page("새 제목"));
    await flush();
    const d = await loadGraph(ctx);
    expect(titles(d)).toContain("새 제목");
    expect(prisma.page.findMany).toHaveBeenCalledTimes(2); // 새 세대는 다시 신선
  });

  it("한 워크스페이스가 SWR 로만 계속 돌아도 10분 넘게 쉰 다른 워크스페이스의 원시 항목은 쓸려난다", async () => {
    m(prisma.page.findMany).mockResolvedValue(page("제목"));
    const other = { workspaceId: "w2", userId: "u1", role: "member" } as never;
    await loadGraph(ctx);
    await loadGraph(other);
    vi.advanceTimersByTime(GRAPH_CACHE_MAX_STALE_MS / 2);
    await loadGraph(ctx); // SWR — 백그라운드 재로드
    await flush();
    vi.advanceTimersByTime(GRAPH_CACHE_MAX_STALE_MS / 2 + 1);
    expect(__graphCacheSizes().raw).toBe(2);
    await loadGraph(ctx); // w1 은 아직 SWR 구간 — 기다리는 경로를 타지 않는다
    expect(__graphCacheSizes()).toEqual({ raw: 1, built: 1 });
  });

  it("상한(10분)을 넘긴 항목은 돌려주지 않고 다시 읽기를 기다린다", async () => {
    m(prisma.page.findMany).mockResolvedValueOnce(page("옛 제목")).mockResolvedValueOnce(page("새 제목"));
    await loadGraph(ctx);
    vi.advanceTimersByTime(GRAPH_CACHE_MAX_STALE_MS + 1);
    const g = await loadGraph(ctx);
    expect(titles(g)).toContain("새 제목");
    expect(prisma.page.findMany).toHaveBeenCalledTimes(2);
  });

  it("상한을 넘겼을 때 진행 중 재로드가 있으면 새로 읽지 않고 그것을 기다린다", async () => {
    m(prisma.page.findMany).mockResolvedValueOnce(page("옛 제목"));
    await loadGraph(ctx);
    const next = deferred<unknown>();
    m(prisma.page.findMany).mockReturnValueOnce(next.promise);
    vi.advanceTimersByTime(GRAPH_CACHE_TTL_MS + 1);
    await loadGraph(ctx); // 백그라운드 재로드 시작
    vi.advanceTimersByTime(GRAPH_CACHE_MAX_STALE_MS);
    const pending = loadGraph(ctx);
    await flush(); // 세대 확인(비동기)을 지나 getRaw 가 진행 중 재로드를 집은 뒤에 끝낸다
    next.resolve(page("새 제목"));
    expect(titles(await pending)).toContain("새 제목");
    expect(prisma.page.findMany).toHaveBeenCalledTimes(2);
  });

  it("백그라운드 재로드가 실패하면 옛 항목을 유지하고 다음 호출이 다시 시도한다", async () => {
    m(prisma.page.findMany).mockResolvedValueOnce(page("옛 제목"));
    await loadGraph(ctx);
    m(prisma.page.findMany).mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce(page("새 제목"));
    vi.advanceTimersByTime(GRAPH_CACHE_TTL_MS + 1);
    expect(titles(await loadGraph(ctx))).toContain("옛 제목");
    await flush();
    expect(titles(await loadGraph(ctx))).toContain("옛 제목"); // 실패 뒤에도 옛 값, 재시도 시작
    expect(prisma.page.findMany).toHaveBeenCalledTimes(3);
    await flush();
    expect(titles(await loadGraph(ctx))).toContain("새 제목");
  });

  it("재로드 중 invalidateGraphCache 가 오면 그 결과를 채택하지 않고 즉시 비운다", async () => {
    m(prisma.page.findMany).mockResolvedValueOnce(page("옛 제목"));
    await loadGraph(ctx);
    const next = deferred<unknown>();
    m(prisma.page.findMany).mockReturnValueOnce(next.promise).mockResolvedValueOnce(page("무효화 뒤"));
    vi.advanceTimersByTime(GRAPH_CACHE_TTL_MS + 1);
    await loadGraph(ctx);
    invalidateGraphCache("w1");
    expect(__graphCacheSizes().raw).toBe(0);
    const g = await loadGraph(ctx);
    expect(titles(g)).toContain("무효화 뒤");
    next.resolve(page("낡은 재로드"));
    await flush();
    expect(titles(await loadGraph(ctx))).toContain("무효화 뒤");
  });
});

describe("loadGraph — 다른 프로세스의 무효화(DB 세대)", () => {
  const flush = () => new Promise<void>((r) => setImmediate(r));
  let dbGen: number;

  beforeEach(() => {
    invalidateGraphCache();
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    m(loadAccess).mockResolvedValue({});
    m(visibleOnly).mockImplementation((_i: unknown, rows: unknown[]) => rows);
    m(pageAccess).mockReturnValue("view");
    m(projectAccess).mockReturnValue("view");
    for (const f of [prisma.page, prisma.project, prisma.decision, prisma.lesson, prisma.risk, prisma.dbRow, prisma.dbProperty, prisma.graphEdge]) {
      m(f.findMany).mockResolvedValue([]);
    }
    dbGen = 3;
    m(prisma.graphCacheGen.findUnique).mockImplementation(async () => ({ gen: dbGen }));
    m(prisma.graphCacheGen.upsert).mockImplementation(async () => ({ gen: ++dbGen }));
  });
  afterEach(() => vi.useRealTimers());

  it("세대가 그대로면 캐시를 쓰고, 다른 프로세스가 올렸으면 확인 간격 뒤 다시 읽는다", async () => {
    await loadGraph(ctx);
    dbGen = 4; // 워커가 invalidateGraphCache — 이 프로세스 메모리는 모른다
    vi.advanceTimersByTime(GRAPH_GEN_CHECK_MS - 1);
    await loadGraph(ctx);
    expect(prisma.page.findMany).toHaveBeenCalledTimes(1); // 간격 안 — 세대를 다시 읽지 않는다
    vi.advanceTimersByTime(2);
    await loadGraph(ctx);
    expect(prisma.page.findMany).toHaveBeenCalledTimes(2); // TTL(60초) 전이지만 세대가 달라 다시 읽는다
    vi.advanceTimersByTime(GRAPH_GEN_CHECK_MS + 1);
    await loadGraph(ctx);
    expect(prisma.page.findMany).toHaveBeenCalledTimes(2); // 새 세대로 기록 — 같은 세대면 그대로
  });

  it("세대 읽기는 워크스페이스당 확인 간격에 한 번 — 동시 요청도 한 번만 읽는다", async () => {
    await Promise.all([loadGraph(ctx), loadGraph(ctx), loadGraph(ctx)]);
    await loadGraph(ctx);
    expect(prisma.graphCacheGen.findUnique).toHaveBeenCalledTimes(1);
    await loadGraph({ workspaceId: "w2", userId: "u1", role: "member" } as never);
    expect(prisma.graphCacheGen.findUnique).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(GRAPH_GEN_CHECK_MS);
    await loadGraph(ctx);
    expect(prisma.graphCacheGen.findUnique).toHaveBeenCalledTimes(3);
  });

  it("invalidateGraphCache(워크스페이스) 는 DB 세대를 올리고, 자기 무효화로 한 번 더 읽지 않는다", async () => {
    await loadGraph(ctx);
    invalidateGraphCache("w1");
    await flush();
    expect(prisma.graphCacheGen.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "w1" }, create: { workspaceId: "w1", gen: 1 }, update: { gen: { increment: 1 } } }),
    );
    await loadGraph(ctx); // 즉시 다시 읽는다(프로세스 안 무효화는 그대로 즉시)
    expect(prisma.page.findMany).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(GRAPH_GEN_CHECK_MS + 1);
    await loadGraph(ctx);
    expect(prisma.page.findMany).toHaveBeenCalledTimes(2); // 올린 세대를 기록해 두었다 — 불필요한 재로드 없음
  });

  it("세대 읽기·쓰기가 실패해도(마이그레이션 전 등) 그래프는 돌고 캐시는 예전처럼 쓴다", async () => {
    m(prisma.graphCacheGen.findUnique).mockRejectedValue(new Error("relation does not exist"));
    m(prisma.graphCacheGen.upsert).mockRejectedValue(new Error("relation does not exist"));
    await loadGraph(ctx);
    vi.advanceTimersByTime(GRAPH_GEN_CHECK_MS + 1);
    await loadGraph(ctx);
    expect(prisma.page.findMany).toHaveBeenCalledTimes(1);
    invalidateGraphCache("w1");
    await flush();
    await loadGraph(ctx);
    expect(prisma.page.findMany).toHaveBeenCalledTimes(2);
  });

  it("invalidateGraphCache() 전체 비우기는 DB 세대를 쓰지 않는다(테스트·프로세스 내부용)", () => {
    invalidateGraphCache();
    expect(prisma.graphCacheGen.upsert).not.toHaveBeenCalled();
  });
});

describe("loadGraph — 보관(F2)", () => {
  beforeEach(() => {
    invalidateGraphCache();
    vi.resetAllMocks();
    m(loadAccess).mockResolvedValue({});
    m(visibleOnly).mockImplementation((_i: unknown, rows: unknown[]) => rows);
    m(pageAccess).mockReturnValue("view");
    m(projectAccess).mockReturnValue("view");
    for (const k of ["decision", "lesson", "risk", "dbRow", "dbProperty", "graphEdge"] as const) m(prisma[k].findMany).mockResolvedValue([]);
    m(prisma.project.findMany).mockResolvedValue([{ id: ID("proj"), name: "보관 프로젝트" }]);
  });

  it("보관 문서와 보관 조상의 하위 문서는 노드에서 빠지고 프로젝트는 남는다", async () => {
    const at = new Date();
    m(prisma.page.findMany).mockResolvedValue([
      { id: ID("p"), title: "보관 부모", markdown: "", parentId: null, projectId: null, archivedAt: at },
      { id: ID("kid"), title: "하위", markdown: "", parentId: ID("p"), projectId: null, archivedAt: null },
      { id: ID("live"), title: "활성", markdown: "", parentId: null, projectId: ID("proj"), archivedAt: null },
    ]);
    const ids = new Set((await loadGraph(ctx)).nodes.map((n) => n.id));
    expect(ids.has(ID("p"))).toBe(false);
    expect(ids.has(ID("kid"))).toBe(false);
    expect(ids.has(ID("live"))).toBe(true);
    expect(ids.has(ID("proj"))).toBe(true);
  });

  it("보관 보드 밑 문서·보관 보드의 행(과 행 본문)은 빠지고 활성 보드는 남는다", async () => {
    const at = new Date();
    const docs = [
      { id: ID("kid"), title: "보관보드 하위", markdown: "", parentId: ID("bArch"), projectId: null, archivedAt: null },
      { id: ID("body1"), title: "보관 행 본문", markdown: "", parentId: null, projectId: null, archivedAt: null },
      { id: ID("body2"), title: "활성 행 본문", markdown: "", parentId: null, projectId: null, archivedAt: null },
      { id: ID("live"), title: "활성 문서", markdown: "", parentId: ID("bLive"), projectId: null, archivedAt: null },
    ];
    m(prisma.page.findMany).mockResolvedValue([
      { id: ID("bArch"), title: "보관 보드", markdown: "", parentId: null, projectId: null, archivedAt: at, kind: "database" },
      { id: ID("bLive"), title: "활성 보드", markdown: "", parentId: null, projectId: null, archivedAt: null, kind: "database" },
      ...docs.map((d) => ({ ...d, kind: "doc" })),
    ]);
    m(prisma.dbRow.findMany).mockResolvedValue([
      { id: ID("r1"), databasePageId: ID("bArch"), contentPageId: ID("body1"), props: {} },
      { id: ID("r2"), databasePageId: ID("bLive"), contentPageId: ID("body2"), props: {} },
    ]);
    const ids = new Set((await loadGraph(ctx)).nodes.map((n) => n.id));
    expect(ids.has(ID("kid"))).toBe(false);
    expect(ids.has(ID("body1"))).toBe(false);
    expect(ids.has(ID("r1"))).toBe(false);
    expect(ids.has(ID("live"))).toBe(true);
    expect(ids.has(ID("body2"))).toBe(true);
    expect(ids.has(ID("r2"))).toBe(true);
  });
});

describe("rowPatchTouchesGraph", () => {
  const text = new Set(["title", "note"]);
  it("text 속성(그래프 제목·본문)이나 문서 연결을 바꾸면 true", () => {
    expect(rowPatchTouchesGraph({ props: { title: "x" } }, text)).toBe(true);
    expect(rowPatchTouchesGraph({ contentPageId: null }, text)).toBe(true);
    expect(rowPatchTouchesGraph({ contentPageId: "p1", props: { status: "s" } }, text)).toBe(true);
  });
  it("text 가 아닌 속성·위치·부모만 바꾸면 false", () => {
    expect(rowPatchTouchesGraph({ props: { status: "s" } }, text)).toBe(false);
    expect(rowPatchTouchesGraph({}, text)).toBe(false);
  });
});
