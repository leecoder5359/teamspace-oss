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
});
