import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/graphLoad", () => ({ loadGraph: vi.fn() }));

import { requireCtx } from "@/lib/workspace";
import { loadGraph } from "@/lib/graphLoad";
import { GET } from "./route";

const m = (f: unknown) => f as Mock;
const ctx = { workspaceId: "w1", userId: "u1", role: "member" };
const G = {
  nodes: [
    { id: "a", title: "A", type: "doc", href: "/p/a", projectId: null },
    { id: "b", title: "B", type: "doc", href: "/p/b", projectId: null },
    { id: "P", title: "P", type: "project", href: "/projects", projectId: "P" },
  ],
  edges: [
    { from: "a", to: "b", kind: "mention", kinds: ["mention"], tag: "추론" },
    { from: "P", to: "a", kind: "contains", kinds: ["contains"], tag: "추출" },
  ],
};

describe("GET /api/graph", () => {
  beforeEach(() => { vi.resetAllMocks(); m(requireCtx).mockResolvedValue(ctx); m(loadGraph).mockResolvedValue(G); });

  it("인증 실패 그대로", async () => {
    m(requireCtx).mockResolvedValue({ err: new Response(null, { status: 401 }) });
    expect((await GET(new Request("http://t/api/graph"))).status).toBe(401);
  });

  it("필터 없으면 전체", async () => {
    const j = await (await GET(new Request("http://t/api/graph"))).json();
    expect(j.nodes).toHaveLength(3);
    expect(j.edges).toHaveLength(2);
  });

  it("types=doc → 프로젝트 노드와 그 간선 제외", async () => {
    const j = await (await GET(new Request("http://t/api/graph?types=doc"))).json();
    expect(j.nodes.map((n: { id: string }) => n.id)).toEqual(["a", "b"]);
    expect(j.edges).toHaveLength(1);
  });

  it("kinds=contains → 해당 kind 를 하나라도 가진 간선만", async () => {
    const j = await (await GET(new Request("http://t/api/graph?kinds=contains"))).json();
    expect(j.edges).toEqual([G.edges[1]]);
  });

  it("project=P → 조각(P 소속 + 1홉)", async () => {
    const g2 = { nodes: [...G.nodes, { id: "z", title: "Z", type: "doc", href: "/p/z", projectId: null }], edges: [...G.edges, { from: "b", to: "z", kind: "link", kinds: ["link"], tag: "추출" }] };
    m(loadGraph).mockResolvedValue(g2);
    const j = await (await GET(new Request("http://t/api/graph?project=P"))).json();
    expect(j.nodes.map((n: { id: string }) => n.id)).toEqual(["a", "P"]);
    const j2 = await (await GET(new Request("http://t/api/graph?project=P&hops=2"))).json();
    expect(j2.nodes.map((n: { id: string }) => n.id)).toEqual(["a", "b", "P"]);
  });

  it("없는 project 는 빈 그래프, 잘못된 hops 는 400", async () => {
    const j = await (await GET(new Request("http://t/api/graph?project=nope"))).json();
    expect(j).toEqual({ nodes: [], edges: [] });
    expect((await GET(new Request("http://t/api/graph?project=P&hops=3"))).status).toBe(400);
  });

  it("hops= (빈 값) 은 생략과 같아 기본 1홉", async () => {
    const g2 = { nodes: [...G.nodes, { id: "z", title: "Z", type: "doc", href: "/p/z", projectId: null }], edges: [...G.edges, { from: "b", to: "z", kind: "link", kinds: ["link"], tag: "추출" }] };
    m(loadGraph).mockResolvedValue(g2);
    const res = await GET(new Request("http://t/api/graph?project=P&hops="));
    expect(res.status).toBe(200);
    expect((await res.json()).nodes.map((n: { id: string }) => n.id)).toEqual(["a", "P"]);
  });

  it("project 없이 hops 만 오면 무시하고 전체 그래프(유효값일 때), 잘못된 값은 400", async () => {
    const ok = await GET(new Request("http://t/api/graph?hops=2"));
    expect(ok.status).toBe(200);
    expect((await ok.json()).nodes).toHaveLength(3);
    const empty = await GET(new Request("http://t/api/graph?hops="));
    expect((await empty.json()).nodes).toHaveLength(3);
    expect((await GET(new Request("http://t/api/graph?hops=0"))).status).toBe(400);
  });
});
