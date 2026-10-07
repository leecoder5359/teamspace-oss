import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/pageGuard", () => ({ loadAccess: vi.fn(async () => ({})), visibleOnly: (_i: unknown, r: unknown[]) => r }));
vi.mock("@/lib/graphLoad", () => ({ loadGraph: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { page: { findMany: vi.fn() }, decision: { findMany: vi.fn(async () => []) } } }));

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
