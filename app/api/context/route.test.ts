import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/pageGuard", () => ({ loadAccess: vi.fn(async () => ({})), pageAccess: () => "view", visibleOnly: (_i: unknown, r: unknown[]) => r }));
vi.mock("@/lib/graphLoad", () => ({ loadGraph: vi.fn() }));
vi.mock("@/lib/prisma", () => {
  const fm = () => ({ findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) });
  return { prisma: { workspaceRouteRule: fm(), project: fm(), workspace: fm(), page: fm(), dbProperty: fm(), dbRow: fm(), decision: fm(), risk: fm(), glossaryTerm: fm(), lesson: fm() } };
});

import { requireCtx } from "@/lib/workspace";
import { loadGraph } from "@/lib/graphLoad";
import { GET } from "./route";

const m = (f: unknown) => f as Mock;
const d = (id: string, projectId: string | null = null) => ({ id, title: `문서-${id}`, type: "doc", href: `/p/${id}`, projectId });
const E = (from: string, to: string) => ({ from, to, kind: "link", kinds: ["link"], tag: "추출" });

describe("GET /api/context — 지식 지도", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "member" });
    m(loadGraph).mockResolvedValue({ nodes: [d("a"), d("b"), d("c")], edges: [E("a", "b"), E("a", "c")] });
  });

  it("compact 에 허브가 들어간다", async () => {
    const md = await (await GET(new Request("http://t/api/context?compact=1"))).text();
    expect(md).toContain("## 지식 지도");
    expect(md).toContain("- 문서-a (연결 2) `a`");
  });

  it("그래프 로드가 실패해도 컨텍스트는 나간다(섹션만 생략)", async () => {
    m(loadGraph).mockRejectedValue(new Error("boom"));
    const res = await GET(new Request("http://t/api/context?compact=1"));
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("## 지식 지도");
  });

  it("그래프 로드가 멈춰도(800ms 타임아웃) 컨텍스트는 나간다", async () => {
    vi.useFakeTimers();
    try {
      m(loadGraph).mockReturnValue(new Promise(() => {}));
      const p = GET(new Request("http://t/api/context?compact=1"));
      await vi.advanceTimersByTimeAsync(900);
      const res = await p;
      expect(res.status).toBe(200);
      const md = await res.text();
      expect(md).not.toContain("## 지식 지도");
      expect(md).toContain("# 워크스페이스");
    } finally {
      vi.useRealTimers();
    }
  });

  it("compact 지도는 ~1200자 안으로 자르되 제목 줄은 유지한다", async () => {
    const nodes = Array.from({ length: 80 }, (_, i) => d(`n${i}`));
    const edges = nodes.slice(1).map((n) => E("n0", n.id));
    m(loadGraph).mockResolvedValue({ nodes, edges });
    const md = await (await GET(new Request("http://t/api/context?compact=1"))).text();
    const start = md.indexOf("## 지식 지도");
    expect(start).toBeGreaterThan(-1);
    const end = md.indexOf("\n## ", start + 5);
    expect(md.slice(start, end === -1 ? undefined : end).length).toBeLessThanOrEqual(1300);
  });
});
