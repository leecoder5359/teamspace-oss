import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/pageGuard", () => ({ loadAccess: vi.fn(async () => ({})), visibleOnly: (_i: unknown, r: unknown[]) => r }));
vi.mock("@/lib/graphLoad", () => ({ loadGraph: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { page: { findMany: vi.fn(), count: vi.fn(async () => 0) }, decision: { findMany: vi.fn(async () => []) } } }));

import { requireCtx } from "@/lib/workspace";
import { loadGraph } from "@/lib/graphLoad";
import { prisma } from "@/lib/prisma";
import { GET } from "./route";

const m = (f: unknown) => f as Mock;

describe("GET /api/search neighbors", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "member" });
    m(prisma.page.findMany).mockResolvedValue([{ id: "a", title: "배포 가이드", markdown: "배포", kind: "doc", updatedAt: new Date(), projectId: null, project: null }]);
    m(prisma.decision.findMany).mockResolvedValue([]);
    m(loadGraph).mockResolvedValue({
      nodes: [{ id: "a", title: "배포 가이드", type: "doc", href: "/p/a", projectId: null }, { id: "b", title: "EC2 설정", type: "doc", href: "/p/b", projectId: null }],
      edges: [{ from: "a", to: "b", kind: "link", kinds: ["link"], tag: "추출" }],
    });
  });

  it("기본은 이웃 없음·그래프 로드 안 함", async () => {
    const j = await (await GET(new Request("http://t/api/search?q=배포"))).json();
    expect(j.results[0].neighbors).toBeUndefined();
    expect(loadGraph).not.toHaveBeenCalled();
  });

  it("neighbors=1 이면 결과에 이웃", async () => {
    const j = await (await GET(new Request("http://t/api/search?q=배포&neighbors=1"))).json();
    expect(j.results[0].neighbors).toEqual([{ id: "b", title: "EC2 설정", type: "doc", kind: "link", tag: "추출" }]);
  });

  it("그래프 로드가 실패해도 검색은 성공(이웃만 생략)", async () => {
    m(loadGraph).mockRejectedValue(new Error("boom"));
    const res = await GET(new Request("http://t/api/search?q=배포&neighbors=1"));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.results).toHaveLength(1);
    expect(j.results[0].neighbors).toBeUndefined();
  });

  describe("보관(F2)", () => {
    const at = new Date("2026-10-09T00:00:00Z");
    const tree = [
      { id: "p", parentId: null, archivedAt: at },
      { id: "kid", parentId: "p", archivedAt: null },
      { id: "other", parentId: null, archivedAt: null },
    ];
    const withArchived = () => {
      m(prisma.page.count).mockResolvedValue(1);
      // 첫 findMany 는 트리 로드(select 에 parentId), 이후는 후보 조회
      m(prisma.page.findMany).mockImplementation((async (args: { select: Record<string, unknown> }) =>
        "parentId" in args.select ? tree : []) as never);
    };
    const whereOfCandidates = () =>
      m(prisma.page.findMany).mock.calls.map((c) => c[0]).find((a) => !("parentId" in a.select)).where;

    it("보관 페이지가 없으면 트리를 읽지 않고 id 필터도 없다", async () => {
      await GET(new Request("http://t/api/search?q=배포"));
      expect(m(prisma.page.findMany).mock.calls.every((c) => !("parentId" in c[0].select))).toBe(true);
      expect(m(prisma.page.findMany).mock.calls[0][0].where).not.toHaveProperty("id");
    });
    it("보관된 부모의 하위 문서도 후보에서 제외", async () => {
      withArchived();
      await GET(new Request("http://t/api/search?q=배포"));
      // 직접 보관된 p 는 SQL archivedAt: null 로, 후손 kid 만 notIn 으로
      expect(whereOfCandidates().archivedAt).toBeNull();
      expect(whereOfCandidates().id.notIn).toEqual(["kid"]);
    });
    it("직접 보관만 있고 후손이 없으면 notIn 없이 archivedAt: null 만", async () => {
      m(prisma.page.count).mockResolvedValue(1);
      m(prisma.page.findMany).mockImplementation((async (args: { select: Record<string, unknown> }) =>
        "parentId" in args.select ? [{ id: "p", parentId: null, archivedAt: at }, { id: "o", parentId: null, archivedAt: null }] : []) as never);
      await GET(new Request("http://t/api/search?q=배포"));
      expect(whereOfCandidates().archivedAt).toBeNull();
      expect(whereOfCandidates()).not.toHaveProperty("id");
    });
    it("?archived=1 이면 제외하지 않고 트리도 읽지 않는다", async () => {
      withArchived();
      await GET(new Request("http://t/api/search?q=배포&archived=1"));
      expect(whereOfCandidates()).not.toHaveProperty("id");
      expect(whereOfCandidates()).not.toHaveProperty("archivedAt");
      expect(m(prisma.page.count)).not.toHaveBeenCalled();
    });
  });

  describe("보관 id 상한(2,000)", () => {
    const at = new Date("2026-10-09T00:00:00Z");
    const big = Array.from({ length: 2001 }, (_, i) => ({ id: `ar${i}`, parentId: null, archivedAt: at }));
    const cand = (id: string) => ({ id, title: "배포 " + id, markdown: "", kind: "doc", updatedAt: new Date(), projectId: null, project: null });
    // 부모(보관) 1개 + 후손 2,001개 — 후손만 notIn/사후 거름 대상
    const kids = [{ id: "root", parentId: null, archivedAt: at }, ...Array.from({ length: 2001 }, (_, i) => ({ id: `kid${i}`, parentId: "root", archivedAt: null }))];
    const setup = (tree: unknown[]) => {
      m(prisma.page.count).mockResolvedValue(1);
      m(prisma.page.findMany).mockImplementation((async (args: { select: Record<string, unknown> }) =>
        "parentId" in args.select ? tree : [cand("ar5"), cand("live")]) as never);
    };
    const cands = () => m(prisma.page.findMany).mock.calls.map((c) => c[0]).filter((a) => !("parentId" in a.select));
    it("상한을 넘으면 notIn 없이 조회하고 결과에서 보관 문서를 거른다", async () => {
      setup([...kids, { id: "ar5", parentId: "root", archivedAt: null }]);
      const j = await (await GET(new Request("http://t/api/search?q=배포"))).json();
      expect(cands().every((a) => !("id" in a.where))).toBe(true);
      expect(j.results.map((r: { id: string }) => r.id)).toEqual(["live"]);
    });
    it("상한 이하(2,000)면 여전히 notIn 을 쓴다", async () => {
      setup(kids.slice(0, 2001));
      await GET(new Request("http://t/api/search?q=배포"));
      expect(cands()[0].where.id.notIn).toHaveLength(2000);
    });
    it("직접 보관 2,001개만으로는 상한 경로로 가지 않는다(SQL 이 거른다)", async () => {
      setup(big);
      await GET(new Request("http://t/api/search?q=배포"));
      expect(cands()[0].where).not.toHaveProperty("id");
      expect(cands()[0].where.archivedAt).toBeNull();
    });
    it("사후 거름 경로: 앞쪽 300개 넘게 보관 후손이어도 take 500 으로 limit 개를 채운다", async () => {
      m(prisma.page.count).mockResolvedValue(1);
      const rows = [...Array.from({ length: 350 }, (_, i) => cand(`kid${i}`)), ...Array.from({ length: 100 }, (_, i) => cand(`live${i}`))];
      m(prisma.page.findMany).mockImplementation((async (args: { select: Record<string, unknown>; take?: number }) =>
        "parentId" in args.select ? kids : rows.slice(0, args.take)) as never);
      const j = await (await GET(new Request("http://t/api/search?q=배포&limit=100"))).json();
      expect(cands()[0].take).toBe(500);
      expect(j.results).toHaveLength(100);
      expect(j.results.every((r: { id: string }) => r.id.startsWith("live"))).toBe(true);
    });
  });

  describe("A6", () => {
    const docRow = (id: string) => ({ id, title: `배포 문서 ${id}`, markdown: "배포", kind: "doc", updatedAt: new Date(), projectId: null, project: null });
    const node = (id: string) => ({ id, title: `T-${id}`, type: "doc", href: `/p/${id}`, projectId: null });

    it("이웃은 상위 5개 결과 × 5개까지만", async () => {
      const rs = Array.from({ length: 7 }, (_, i) => `r${i}`);
      m(prisma.page.findMany).mockResolvedValue(rs.map(docRow));
      const nodes = [...rs.map(node), ...Array.from({ length: 8 }, (_, i) => node(`n${i}`))];
      const edges = rs.flatMap((r) => Array.from({ length: 8 }, (_, i) => ({ from: r, to: `n${i}`, kind: "link", kinds: ["link"], tag: "추출" })));
      m(loadGraph).mockResolvedValue({ nodes, edges });
      const j = await (await GET(new Request("http://t/api/search?q=배포&neighbors=1"))).json();
      expect(j.results.length).toBe(7);
      const withNb = j.results.filter((r: { neighbors?: unknown[] }) => r.neighbors !== undefined);
      expect(withNb).toHaveLength(5);
      expect(withNb.map((r: { id: string }) => r.id)).toEqual(j.results.slice(0, 5).map((r: { id: string }) => r.id));
      for (const r of withNb) expect(r.neighbors).toHaveLength(5);
    });

    it("loadGraph 에는 정의된 접근 색인이 2번째 인자로 간다", async () => {
      const IDX = { marker: "idx" };
      const { loadAccess } = await import("@/lib/pageGuard");
      m(loadAccess).mockResolvedValue(IDX);
      await GET(new Request("http://t/api/search?q=배포&neighbors=1"));
      expect(loadGraph).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "w1" }), IDX);
    });

    it("그래프에 없는 결과는 neighbors: []", async () => {
      m(loadGraph).mockResolvedValue({ nodes: [node("zz")], edges: [] });
      const j = await (await GET(new Request("http://t/api/search?q=배포&neighbors=1"))).json();
      expect(j.results[0].neighbors).toEqual([]);
    });
  });
});

describe("GET /api/search 공백 변형", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "member" });
    m(prisma.decision.findMany).mockResolvedValue([]);
  });

  it("where 가 변형 OR 이고 공백 변형 문서가 결과에 남는다", async () => {
    m(prisma.page.findMany).mockResolvedValue([{ id: "a", title: "인증 코어 설계", markdown: "", kind: "doc", updatedAt: new Date(), projectId: null, project: null }]);
    const j = await (await GET(new Request("http://t/api/search?q=" + encodeURIComponent("인증코어")))).json();
    const where = m(prisma.page.findMany).mock.calls[1][0].where;
    expect(where.OR).toContainEqual({ title: { contains: "인증 코어", mode: "insensitive" } });
    expect(m(prisma.page.findMany).mock.calls[0][0].where.OR).toEqual([{ title: { contains: "인증코어", mode: "insensitive" } }, { markdown: { contains: "인증코어", mode: "insensitive" } }]);
    expect(where.AND).toBeDefined();
    expect(j.results.map((r: { id: string }) => r.id)).toEqual(["a"]);
  });

  it("원문 일치가 변형 일치보다 먼저", async () => {
    const row = (id: string, title: string) => ({ id, title, markdown: "", kind: "doc", updatedAt: new Date(), projectId: null, project: null });
    m(prisma.page.findMany).mockResolvedValue([row("v", "인증 코어"), row("o", "인증코어")]);
    const j = await (await GET(new Request("http://t/api/search?q=" + encodeURIComponent("인증코어")))).json();
    expect(j.results.map((r: { id: string }) => r.id)).toEqual(["o", "v"]);
  });
});

describe("GET /api/search 후보 조회 순서", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "member" });
    m(prisma.decision.findMany).mockResolvedValue([]);
  });
  const row = (id: string) => ({ id, title: "인증코어 " + id, markdown: "", kind: "doc", updatedAt: new Date(), projectId: null, project: null });

  it("원문이 limit 을 채우면 변형 쿼리를 하지 않는다", async () => {
    m(prisma.page.findMany).mockResolvedValue([row("a"), row("b")]);
    await GET(new Request("http://t/api/search?q=" + encodeURIComponent("인증코어") + "&limit=2"));
    expect(prisma.page.findMany).toHaveBeenCalledTimes(1);
  });

  it("모자라면 변형 OR 로 채우고 id 중복 제거", async () => {
    m(prisma.page.findMany).mockResolvedValueOnce([row("a")]).mockResolvedValueOnce([row("a"), row("b")]);
    const j = await (await GET(new Request("http://t/api/search?q=" + encodeURIComponent("인증코어")))).json();
    expect(prisma.page.findMany).toHaveBeenCalledTimes(2);
    expect(j.results.map((r: { id: string }) => r.id).sort()).toEqual(["a", "b"]);
  });
});

describe("GET /api/search 변형 폴백은 필터 후 건수로 비교", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "member" });
    m(prisma.decision.findMany).mockResolvedValue([]);
    m(prisma.page.count).mockResolvedValue(0);
  });
  const row = (id: string, projectId: string | null, title = "인증코어") => ({ id, title, markdown: "", kind: "doc", updatedAt: new Date(), projectId, project: null });

  it("원문 후보가 limit 이상이어도 projectId 필터에 다 걸러지면 변형을 조회한다", async () => {
    m(prisma.page.findMany)
      .mockResolvedValueOnce([row("x1", "other"), row("x2", "other")])
      .mockResolvedValueOnce([row("v1", "p1", "인증 코어")]);
    const j = await (await GET(new Request("http://t/api/search?q=" + encodeURIComponent("인증코어") + "&projectId=p1&limit=2"))).json();
    expect(m(prisma.page.findMany)).toHaveBeenCalledTimes(2);
    expect(j.results.map((r: { id: string }) => r.id)).toEqual(["v1"]);
  });

  it("필터 통과 건수가 limit 이상이면 변형을 조회하지 않는다", async () => {
    m(prisma.page.findMany).mockResolvedValueOnce([row("a", "p1"), row("b", "p1")]);
    await GET(new Request("http://t/api/search?q=" + encodeURIComponent("인증코어") + "&projectId=p1&limit=2"));
    expect(m(prisma.page.findMany)).toHaveBeenCalledTimes(1);
  });
});
