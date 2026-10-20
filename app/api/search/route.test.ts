import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/pageGuard", () => ({ loadAccess: vi.fn(async () => ({})), visibleOnly: (_i: unknown, r: unknown[]) => r }));
vi.mock("@/lib/graphLoad", () => ({ loadGraph: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { page: { findMany: vi.fn(), count: vi.fn(async () => 0) }, decision: { findMany: vi.fn(async () => []) } } }));
// ① 일치 id(실DB 동작은 lib/searchPageIds.db.test.ts). 여기선 ②가 그 id 로 어떻게 거르는지만 본다.
vi.mock("@/lib/searchPageIds", () => ({ trigramPageIds: vi.fn(), shortQueryPageIds: vi.fn() }));

import { requireCtx } from "@/lib/workspace";
import { loadGraph } from "@/lib/graphLoad";
import { prisma } from "@/lib/prisma";
import { shortQueryPageIds, trigramPageIds } from "@/lib/searchPageIds";
import { TASK_NOTE_EXCLUDE } from "@/lib/taskNotes";
import { GET } from "./route";

const m = (f: unknown) => f as Mock;

describe("GET /api/search neighbors", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "member" });
    m(trigramPageIds).mockResolvedValue(["m"]);
    m(shortQueryPageIds).mockResolvedValue(["m"]);
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

    it("보관 페이지가 없으면 트리를 읽지 않고 ①의 id 를 그대로 쓴다", async () => {
      m(shortQueryPageIds).mockResolvedValue(["a", "kid"]);
      await GET(new Request("http://t/api/search?q=배포"));
      expect(m(prisma.page.findMany).mock.calls.every((c) => !("parentId" in c[0].select))).toBe(true);
      expect(m(prisma.page.findMany).mock.calls[0][0].where.id).toEqual({ in: ["a", "kid"] });
    });
    it("보관된 부모의 하위 문서도 후보에서 제외", async () => {
      withArchived();
      m(shortQueryPageIds).mockResolvedValue(["kid", "other"]);
      await GET(new Request("http://t/api/search?q=배포"));
      // 직접 보관된 p 는 SQL archivedAt: null 로, 후손 kid 는 ①의 id 에서 뺀다
      expect(whereOfCandidates().archivedAt).toBeNull();
      expect(whereOfCandidates().id).toEqual({ in: ["other"] });
    });
    it("직접 보관만 있고 후손이 없으면 id 는 그대로, archivedAt: null", async () => {
      m(prisma.page.count).mockResolvedValue(1);
      m(prisma.page.findMany).mockImplementation((async (args: { select: Record<string, unknown> }) =>
        "parentId" in args.select ? [{ id: "p", parentId: null, archivedAt: at }, { id: "o", parentId: null, archivedAt: null }] : []) as never);
      m(shortQueryPageIds).mockResolvedValue(["o"]);
      await GET(new Request("http://t/api/search?q=배포"));
      expect(whereOfCandidates().archivedAt).toBeNull();
      expect(whereOfCandidates().id).toEqual({ in: ["o"] });
    });
    it("?archived=1 이면 제외하지 않고 트리도 읽지 않는다", async () => {
      withArchived();
      m(shortQueryPageIds).mockResolvedValue(["kid", "p"]);
      await GET(new Request("http://t/api/search?q=배포&archived=1"));
      expect(whereOfCandidates().id).toEqual({ in: ["kid", "p"] });
      expect(whereOfCandidates()).not.toHaveProperty("archivedAt");
      expect(m(prisma.page.count)).not.toHaveBeenCalled();
      expect(shortQueryPageIds).toHaveBeenCalledWith("w1", ["배포"], { includeArchived: true, includeTaskNotes: false });
    });
  });

  describe("보관 후손이 많아도(2,001) notIn 없이 ①의 id 에서 뺀다", () => {
    const at = new Date("2026-10-09T00:00:00Z");
    const kids = [{ id: "root", parentId: null, archivedAt: at }, ...Array.from({ length: 2001 }, (_, i) => ({ id: `kid${i}`, parentId: "root", archivedAt: null }))];
    it("후손 id 는 ②의 id 목록에 없다", async () => {
      m(prisma.page.count).mockResolvedValue(1);
      m(prisma.page.findMany).mockImplementation((async (args: { select: Record<string, unknown> }) =>
        "parentId" in args.select ? kids : []) as never);
      m(shortQueryPageIds).mockResolvedValue(["kid5", "live"]);
      await GET(new Request("http://t/api/search?q=배포"));
      const cand = m(prisma.page.findMany).mock.calls.map((c) => c[0]).find((a) => !("parentId" in a.select));
      expect(cand.where.id).toEqual({ in: ["live"] });
      expect(cand.take).toBe(300);
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
    m(trigramPageIds).mockResolvedValue(["m"]);
    m(shortQueryPageIds).mockResolvedValue(["m"]);
    m(prisma.decision.findMany).mockResolvedValue([]);
  });

  it("where 가 변형 OR 이고 공백 변형 문서가 결과에 남는다", async () => {
    m(prisma.page.findMany).mockResolvedValue([{ id: "a", title: "인증 코어 설계", markdown: "", kind: "doc", updatedAt: new Date(), projectId: null, project: null }]);
    const j = await (await GET(new Request("http://t/api/search?q=" + encodeURIComponent("인증코어")))).json();
    expect(m(trigramPageIds).mock.calls[1]).toEqual(["w1", expect.arrayContaining(["인증 코어"])]);
    expect(m(trigramPageIds).mock.calls[0]).toEqual(["w1", ["인증코어"]]);
    // ②에는 ILIKE 를 다시 싣지 않는다(실으면 PG 가 그걸 먼저 평가해 본문을 다 푼다)
    const where = m(prisma.page.findMany).mock.calls[1][0].where;
    // ①은 id 만 — 워크스페이스·삭제·보관·태스크 설명 격리는 ②의 where 가 진다(빠지면 다른 워크스페이스·휴지통 문서가 샌다)
    expect(where).toEqual({ workspaceId: "w1", deletedAt: null, archivedAt: null, id: { in: ["m"] }, AND: [TASK_NOTE_EXCLUDE] });
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
    m(trigramPageIds).mockResolvedValue(["m"]);
    m(shortQueryPageIds).mockResolvedValue(["m"]);
    m(prisma.decision.findMany).mockResolvedValue([]);
  });
  const row = (id: string) => ({ id, title: "인증코어 " + id, markdown: "", kind: "doc", updatedAt: new Date(), projectId: null, project: null });

  it("원문 조회와 변형 조회를 동시에 시작한다(직렬로 기다리지 않음)", async () => {
    let releaseFirst!: (v: unknown) => void;
    m(prisma.page.findMany)
      .mockReturnValueOnce(new Promise((r) => { releaseFirst = r; }))
      .mockResolvedValueOnce([row("b")]);
    const res = GET(new Request("http://t/api/search?q=" + encodeURIComponent("인증코어")));
    await vi.waitFor(() => expect(prisma.page.findMany).toHaveBeenCalledTimes(2));
    expect(m(trigramPageIds).mock.calls[0][1]).toEqual(["인증코어"]); // 원문
    expect(m(trigramPageIds).mock.calls[1][1].length).toBeGreaterThan(1); // 변형
    releaseFirst([row("a")]);
    const j = await (await res).json();
    expect(j.results.map((r: { id: string }) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("원문이 limit 을 채우면 변형 결과를 합치지 않는다", async () => {
    m(prisma.page.findMany).mockResolvedValueOnce([row("a"), row("b")]).mockResolvedValueOnce([row("z")]);
    const j = await (await GET(new Request("http://t/api/search?q=" + encodeURIComponent("인증코어") + "&limit=2"))).json();
    expect(j.results.map((r: { id: string }) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("원문이 limit 을 채우면 변형 조회를 기다리지 않고 응답한다", async () => {
    m(prisma.page.findMany).mockResolvedValueOnce([row("a"), row("b")]).mockReturnValueOnce(new Promise(() => {})); // 변형은 끝나지 않는다
    const j = await (await GET(new Request("http://t/api/search?q=" + encodeURIComponent("인증코어") + "&limit=2"))).json();
    expect(j.results.map((r: { id: string }) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("원문이 limit 을 채우면 변형 조회가 실패해도 응답은 성공한다", async () => {
    m(prisma.page.findMany).mockResolvedValueOnce([row("a"), row("b")]).mockRejectedValueOnce(new Error("variant boom"));
    const res = await GET(new Request("http://t/api/search?q=" + encodeURIComponent("인증코어") + "&limit=2"));
    expect(res.status).toBe(200);
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
    m(trigramPageIds).mockResolvedValue(["m"]);
    m(shortQueryPageIds).mockResolvedValue(["m"]);
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

  it("필터 통과 건수가 limit 이상이면 변형 결과를 합치지 않는다", async () => {
    m(prisma.page.findMany).mockResolvedValueOnce([row("a", "p1"), row("b", "p1")]).mockResolvedValueOnce([row("v1", "p1", "인증 코어")]);
    const j = await (await GET(new Request("http://t/api/search?q=" + encodeURIComponent("인증코어") + "&projectId=p1&limit=2"))).json();
    expect(j.results.map((r: { id: string }) => r.id).sort()).toEqual(["a", "b"]);
  });
});

describe("GET /api/search ① 일치 id 길 고르기(P-3)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "member" });
    m(trigramPageIds).mockResolvedValue([]);
    m(shortQueryPageIds).mockResolvedValue([]);
    m(prisma.decision.findMany).mockResolvedValue([]);
    m(prisma.page.count).mockResolvedValue(0);
  });

  it("3글자 이상은 트라이그램, 미만은 짧은 질의 길", async () => {
    await GET(new Request("http://t/api/search?q=" + encodeURIComponent("인증코어")));
    expect(trigramPageIds).toHaveBeenCalled();
    expect(shortQueryPageIds).not.toHaveBeenCalled();
    vi.clearAllMocks();
    await GET(new Request("http://t/api/search?q=배포&includeTaskNotes=1"));
    expect(trigramPageIds).not.toHaveBeenCalled();
    expect(shortQueryPageIds).toHaveBeenCalledWith("w1", ["배포"], { includeArchived: false, includeTaskNotes: true });
  });

  it("변형 중 3글자 미만이 섞이면 그 변형 묶음만 짧은 질의 길(\"a b\" → \"ab\")", async () => {
    await GET(new Request("http://t/api/search?q=" + encodeURIComponent("a b")));
    expect(m(trigramPageIds).mock.calls.map((c) => c[1])).toEqual([["a b"]]);
    expect(m(shortQueryPageIds).mock.calls[0][1]).toEqual(["ab"]);
  });

  it("① 일치가 없으면 ②(본문 조회)를 하지 않는다", async () => {
    const j = await (await GET(new Request("http://t/api/search?q=" + encodeURIComponent("없는말입니다")))).json();
    expect(prisma.page.findMany).not.toHaveBeenCalled();
    expect(j.results).toEqual([]);
  });
});
