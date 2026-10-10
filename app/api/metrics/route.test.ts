import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { metricSnapshot: { findMany: vi.fn() } } }));
vi.mock("@/lib/metrics", async (orig) => ({ ...(await orig<typeof import("@/lib/metrics")>()), snapshotWeek: vi.fn() }));

import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { snapshotWeek } from "@/lib/metrics";
import { GET, POST } from "./route";

const m = (f: unknown) => f as Mock;
const data = (docs: number) => ({ docs, docsBytes: 1, tasksOpen: 0, tasksDone: 0, graphNodes: 0, graphEdges: 0, llm: { calls: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, usd: null }, injection: { count: 0, chars: 0 }, llmCacheRows: 0 });

describe("/api/metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", role: "admin" });
  });
  it("GET: 최신 주 먼저 + 최근 2주 diff, weeks 기본 8", async () => {
    m(prisma.metricSnapshot.findMany).mockResolvedValue([
      { weekKey: "2026-W41", data: data(12), createdAt: new Date("2026-10-09") },
      { weekKey: "2026-W40", data: data(10), createdAt: new Date("2026-10-02") },
    ]);
    const j = await (await GET(new Request("http://t/api/metrics"))).json();
    expect(m(prisma.metricSnapshot.findMany).mock.calls[0][0].take).toBe(8);
    expect(j.weeks.map((w: { weekKey: string }) => w.weekKey)).toEqual(["2026-W41", "2026-W40"]);
    expect(j.diff.find((d: { key: string }) => d.key === "docs")).toEqual({ key: "docs", prev: 10, cur: 12, delta: 2 });
  });
  it("GET: 스냅샷 0개면 diff 빈 배열, weeks 범위 밖은 400", async () => {
    m(prisma.metricSnapshot.findMany).mockResolvedValue([]);
    expect((await (await GET(new Request("http://t/api/metrics?weeks=3"))).json()).diff).toEqual([]);
    expect((await GET(new Request("http://t/api/metrics?weeks=0"))).status).toBe(400);
    expect((await GET(new Request("http://t/api/metrics?weeks=53"))).status).toBe(400);
  });
  it("GET: editor 이상을 요구한다 — viewer 는 403", async () => {
    m(requireCtx).mockResolvedValue({ err: NextResponse.json({}, { status: 403 }) });
    expect((await GET(new Request("http://t/api/metrics"))).status).toBe(403);
    expect(requireCtx).toHaveBeenCalledWith("editor");
    expect(prisma.metricSnapshot.findMany).not.toHaveBeenCalled();
  });
  const rows = () => [
    { weekKey: "2026-W41", data: data(12), createdAt: new Date("2026-10-09") },
    { weekKey: "2026-W40", data: data(10), createdAt: new Date("2026-10-02") },
  ];
  it("GET: editor 응답에는 usd 키가 어디에도 없다(깊은 검사)", async () => {
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", role: "editor" });
    m(prisma.metricSnapshot.findMany).mockResolvedValue(rows());
    const j = await (await GET(new Request("http://t/api/metrics"))).json();
    expect(JSON.stringify(j)).not.toMatch(/usd/i);
    expect(j.diff.length).toBeGreaterThan(0);
  });
  it("GET: admin 응답에는 usd 가 있다(null 가능)", async () => {
    m(prisma.metricSnapshot.findMany).mockResolvedValue(rows());
    const j = await (await GET(new Request("http://t/api/metrics"))).json();
    expect(j.weeks[0].data.llm).toHaveProperty("usd", null);
    expect(j.diff.some((d: { key: string }) => d.key === "llm.usd")).toBe(true);
  });
  it("POST 는 admin 을 요구한다", async () => {
    m(requireCtx).mockResolvedValue({ err: NextResponse.json({}, { status: 403 }) });
    expect((await POST()).status).toBe(403);
    expect(requireCtx).toHaveBeenCalledWith("admin");
    expect(snapshotWeek).not.toHaveBeenCalled();
  });
  it("POST: 스냅샷 생성 결과를 돌려준다", async () => {
    m(snapshotWeek).mockResolvedValue({ created: true, weekKey: "2026-W41" });
    expect(await (await POST()).json()).toEqual({ created: true, weekKey: "2026-W41" });
  });
});
