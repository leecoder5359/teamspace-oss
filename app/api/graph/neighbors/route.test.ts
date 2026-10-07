import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/graphLoad", () => ({ loadGraph: vi.fn() }));

import { requireCtx } from "@/lib/workspace";
import { loadGraph } from "@/lib/graphLoad";
import { GET } from "./route";

const m = (f: unknown) => f as Mock;
const G = {
  nodes: [{ id: "a", title: "A", type: "doc", href: "/p/a", projectId: null }, { id: "b", title: "B", type: "doc", href: "/p/b", projectId: null }],
  edges: [{ from: "a", to: "b", kind: "link", kinds: ["link"], tag: "추출" }],
};

describe("GET /api/graph/neighbors", () => {
  beforeEach(() => { vi.resetAllMocks(); m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "member" }); m(loadGraph).mockResolvedValue(G); });

  it("id 없으면 400", async () => {
    expect((await GET(new Request("http://t/api/graph/neighbors"))).status).toBe(400);
  });

  it("그래프에 없는(=못 보는) id 는 404 — 존재 여부도 흘리지 않는다", async () => {
    expect((await GET(new Request("http://t/api/graph/neighbors?id=hidden"))).status).toBe(404);
  });

  it("이웃 반환", async () => {
    const j = await (await GET(new Request("http://t/api/graph/neighbors?id=a"))).json();
    expect(j.node.id).toBe("a");
    expect(j.neighbors).toEqual([expect.objectContaining({ id: "b", kind: "link", tag: "추출", direction: "out", hop: 1 })]);
  });
});
