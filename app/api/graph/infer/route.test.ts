import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/pageGuard", () => ({ loadAccess: vi.fn(), visibleOnly: vi.fn() }));
vi.mock("@/lib/graphLoad", () => ({ loadGraph: vi.fn(), invalidateGraphCache: vi.fn() }));
vi.mock("@/lib/llm", () => ({ complete: vi.fn(), resolveProvider: () => "cli" }));
vi.mock("@/lib/prisma", () => ({
  prisma: { page: { findMany: vi.fn(), update: vi.fn() }, $executeRaw: vi.fn(), graphEdge: { upsert: vi.fn() } },
}));

import { requireCtx } from "@/lib/workspace";
import { loadAccess, visibleOnly } from "@/lib/pageGuard";
import { loadGraph, invalidateGraphCache } from "@/lib/graphLoad";
import { complete } from "@/lib/llm";
import { prisma } from "@/lib/prisma";
import { POST } from "./route";

const m = (f: unknown) => f as Mock;
const doc = (id: string, title: string) => ({ id, title, type: "doc", href: `/p/${id}`, projectId: null });
const G = { nodes: [doc("w1d", "외톨이"), doc("a", "문서A"), doc("b", "문서B")], edges: [{ from: "a", to: "b", kind: "link", kinds: ["link"], tag: "추출" }] };
const req = (body: unknown) => new Request("http://t/api/graph/infer", { method: "POST", body: JSON.stringify(body) });

// findMany 는 두 번 불린다: 시도함 조회(where.inferTriedAt) · 본문 조회. tried 는 기본 빈 목록.
let triedIds: string[] = [];
let triedAt: Record<string, Date> = {}; // 기본 2020-01-01
let bodyRows: unknown[] = [];
const wireFindMany = () =>
  m(prisma.page.findMany).mockImplementation(async (a: { where: { inferTriedAt?: unknown } }) =>
    a.where.inferTriedAt ? triedIds.map((id) => ({ id, inferTriedAt: triedAt[id] ?? new Date("2020-01-01T00:00:00Z") })) : bodyRows,
  );

describe("POST /api/graph/infer", () => {
  beforeEach(() => {
    triedIds = [];
    triedAt = {};
    bodyRows = [{ id: "w1d", markdown: "본문" }];
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor" });
    m(loadAccess).mockResolvedValue({ idx: true });
    m(visibleOnly).mockImplementation((_i: unknown, r: unknown[]) => r);
    m(loadGraph).mockResolvedValue(G);
    wireFindMany();
    m(complete).mockResolvedValue(`[{"id":"a","reason":"관련"},{"id":"hidden","reason":"x"}]`);
  });

  it("editor 이상", async () => {
    m(requireCtx).mockResolvedValue({ err: new Response(null, { status: 403 }) });
    expect((await POST(req({}))).status).toBe(403);
    expect(requireCtx).toHaveBeenCalledWith("editor");
  });

  it("dryRun: 제안만, 저장 없음. 후보는 그래프(=볼 수 있는) 문서만", async () => {
    const j = await (await POST(req({ dryRun: true }))).json();
    expect(j.processed).toEqual([{ id: "w1d", title: "외톨이", related: [{ id: "a", title: "문서A", reason: "관련" }] }]);
    expect(prisma.graphEdge.upsert).not.toHaveBeenCalled();
    expect(invalidateGraphCache).not.toHaveBeenCalled();
    const prompt = m(complete).mock.calls[0][0] as string;
    expect(prompt).not.toContain("hidden");
    expect(prompt).not.toContain("w1d\t"); // 자기 자신은 후보 아님
  });

  it("본문은 visibleOnly 를 거친다 — 못 보는 페이지 본문은 프롬프트에 안 실린다", async () => {
    m(visibleOnly).mockReturnValue([]);
    await POST(req({ dryRun: true }));
    expect(visibleOnly).toHaveBeenCalledWith({ idx: true }, [{ id: "w1d", markdown: "본문" }]);
    expect(loadGraph).toHaveBeenCalledWith(expect.anything(), { idx: true });
    expect(m(complete).mock.calls[0][0] as string).not.toContain("본문");
  });

  it("저장: fromId|toId|kind 로 upsert", async () => {
    await POST(req({}));
    expect(prisma.graphEdge.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { fromId_toId_kind: { fromId: "w1d", toId: "a", kind: "related" } },
    }));
    expect(invalidateGraphCache).toHaveBeenCalledWith("w1"); // 새 간선이 그래프 캐시를 기다리지 않게
  });

  it("LLM 없음 → 503, 본문에 processed 배열", async () => {
    m(complete).mockResolvedValue(null);
    const res = await POST(req({}));
    expect(res.status).toBe(503);
    expect((await res.json()).processed).toEqual([]);
  });

  it("시도한 문서는 건너뛰고 skippedTried·remaining 에 반영", async () => {
    m(loadGraph).mockResolvedValue({ nodes: [doc("w1d", "가문서"), doc("w2d", "나문서"), doc("w3d", "다문서")], edges: [] });
    bodyRows = [];
    triedIds = ["w1d"];
    const j = await (await POST(req({ limit: 1, dryRun: true }))).json();
    expect(j.processed.map((p: { id: string }) => p.id)).toEqual(["w2d"]);
    expect(j.remaining).toBe(1);
    expect(j.skippedTried).toBe(1);
  });

  it("retry:true 면 시도한 문서도 다시 대상(skippedTried 0)", async () => {
    m(loadGraph).mockResolvedValue({ nodes: [doc("w1d", "가문서"), doc("w2d", "나문서")], edges: [] });
    bodyRows = [];
    triedIds = ["w1d"];
    const j = await (await POST(req({ limit: 1, dryRun: true, retry: true }))).json();
    expect(j.processed.map((p: { id: string }) => p.id)).toEqual(["w1d"]);
    expect(j.skippedTried).toBe(0);
  });

  it("retryBefore: 그 시각 이전에 시도한 문서만 다시, 이후 시도는 건너뛴다", async () => {
    m(loadGraph).mockResolvedValue({ nodes: [doc("w1d", "가문서"), doc("w2d", "나문서"), doc("w3d", "다문서")], edges: [] });
    bodyRows = [];
    triedIds = ["w1d", "w2d"];
    triedAt = { w1d: new Date("2026-01-01T00:00:00Z"), w2d: new Date("2026-06-01T00:00:00Z") };
    const j = await (await POST(req({ limit: 10, dryRun: true, retryBefore: "2026-03-01T00:00:00.000Z" }))).json();
    expect(j.processed.map((p: { id: string }) => p.id).sort()).toEqual(["w1d", "w3d"]);
    expect(j.skippedTried).toBe(1);
  });

  it("retryBefore 가 ISO 시각이 아니면 400", async () => {
    expect((await POST(req({ retryBefore: "어제" }))).status).toBe(400);
  });

  it("exclude 는 받아서 무시한다(크기 제한도 없음)", async () => {
    m(loadGraph).mockResolvedValue({ nodes: [doc("w1d", "가문서"), doc("w2d", "나문서")], edges: [] });
    bodyRows = [];
    const j = await (await POST(req({ limit: 1, dryRun: true, exclude: Array.from({ length: 6000 }, (_, i) => `x${i}`) }))).json();
    expect(j.processed.map((p: { id: string }) => p.id)).toEqual(["w1d"]);
  });

  it("LLM 응답을 받으면 inferTriedAt 을 raw SQL 로 찍는다(page.update 안 씀 — updatedAt 불변) · dryRun/503 은 안 찍는다", async () => {
    m(complete).mockResolvedValue("[]");
    await POST(req({}));
    expect(prisma.page.update).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [strings, ...vals] = m(prisma.$executeRaw).mock.calls[0] as [string[], ...unknown[]];
    expect(strings.join("?")).toContain('SET "inferTriedAt" = NOW()');
    expect(strings.join("?")).not.toContain("updatedAt");
    expect(vals).toEqual(["w1d", expect.any(String)]);
    m(prisma.$executeRaw).mockClear();
    await POST(req({ dryRun: true }));
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    m(complete).mockResolvedValue(null);
    expect((await POST(req({}))).status).toBe(503);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it("limit 가 숫자가 아니면 400", async () => {
    expect((await POST(req({ limit: "5" }))).status).toBe(400);
  });

  it("limit 0·음수·소수는 1..20 으로 클램프(옛 동작)", async () => {
    expect((await POST(req({ limit: 0, dryRun: true }))).status).toBe(200);
    expect((await POST(req({ limit: -3, dryRun: true }))).status).toBe(200);
    expect((await POST(req({ limit: 1.7, dryRun: true }))).status).toBe(200);
  });

  it("limit 20 은 20개까지, 20 초과는 20 으로 클램프", async () => {
    const nodes = Array.from({ length: 25 }, (_, i) => doc(`d${String(i).padStart(2, "0")}`, `문서${String(i).padStart(2, "0")}`));
    m(loadGraph).mockResolvedValue({ nodes, edges: [] });
    bodyRows = [];
    const j = await (await POST(req({ limit: 20, dryRun: true }))).json();
    expect(j.processed).toHaveLength(20);
    expect(j.remaining).toBe(5);
    const big = await (await POST(req({ limit: 999, dryRun: true }))).json();
    expect(big.processed).toHaveLength(20);
    expect(big.remaining).toBe(5);
  });

  it("재시도(retry·retryBefore)는 LLM 캐시를 우회(cache:false), 평소엔 cache 옵션 없음", async () => {
    await POST(req({ dryRun: true }));
    expect(m(complete).mock.calls[0][1]).toEqual({ feature: "graph-infer", workspaceId: "w1", cache: undefined });
    m(complete).mockClear();
    await POST(req({ dryRun: true, retry: true }));
    expect(m(complete).mock.calls[0][1]).toMatchObject({ feature: "graph-infer", cache: false });
    m(complete).mockClear();
    await POST(req({ dryRun: true, retryBefore: "2026-03-01T00:00:00.000Z" }));
    expect(m(complete).mock.calls[0][1]).toMatchObject({ cache: false });
  });

  describe("A1: 후보 상한·사전 순위", () => {
    const many = () => Array.from({ length: 100 }, (_, i) => doc(`d${String(i).padStart(3, "0")}`, `잡문서${String(i).padStart(3, "0")}`));
    const candidatesOf = (prompt: string) => prompt.split("[후보] (id<TAB>제목)\n")[1].split("\n").filter(Boolean).map((l) => l.split("\t")[0]);

    it("후보는 최대 60개, 가장 비슷한 문서가 (제목순으로 뒤여도) 들어간다", async () => {
      const nodes = [doc("t", "고립문서"), ...many(), doc("zz", "쿠버네티스 배포 파이프라인")];
      m(loadGraph).mockResolvedValue({ nodes, edges: [{ from: "d000", to: "d001", kind: "link", kinds: ["link"], tag: "추출" }] });
      bodyRows = [
        { id: "t", markdown: "쿠버네티스 배포 파이프라인 정리" },
        { id: "zz", markdown: "쿠버네티스 배포 파이프라인 단계" },
      ];
      await POST(req({ limit: 1, dryRun: true }));
      const cands = candidatesOf(m(complete).mock.calls[0][0] as string);
      expect(cands.length).toBeLessThanOrEqual(60);
      expect(cands.length).toBe(60);
      expect(cands[0]).toBe("zz");
      expect(cands).not.toContain("t");
      // 시도함 조회 1 + 본문 조회 1 — 본문은 한 번에
      expect(m(prisma.page.findMany).mock.calls.filter(([a]) => !(a as { where: { inferTriedAt?: unknown } }).where.inferTriedAt)).toHaveLength(1);
    });

    it("그래프 노드지만 visibleOnly 가 거른 문서: 본문이 프롬프트·순위에 안 쓰인다", async () => {
      const nodes = [doc("t", "고립문서"), ...many(), doc("zz", "힛든문서")];
      m(loadGraph).mockResolvedValue({ nodes, edges: [{ from: "d000", to: "d001", kind: "link", kinds: ["link"], tag: "추출" }] });
      bodyRows = [
        { id: "t", markdown: "쿠버네티스 배포 파이프라인 정리" },
        { id: "zz", markdown: "쿠버네티스 배포 파이프라인 단계 극비본문토큰" },
      ];
      m(visibleOnly).mockImplementation((_i: unknown, r: { id: string }[]) => r.filter((x) => x.id !== "zz"));
      await POST(req({ limit: 1, dryRun: true }));
      const prompt = m(complete).mock.calls[0][0] as string;
      expect(prompt).not.toContain("극비본문토큰");
      // 색인에 있었다면 가장 비슷해 1순위였을 문서 — 제목순 채움(100개 중 60)에선 밀려난다
      expect(candidatesOf(prompt)).not.toContain("zz");
    });

    it("못 보는 문서(그래프에 없음·visibleOnly 가 거른 행)는 후보·색인에 안 들어간다", async () => {
      m(loadGraph).mockResolvedValue({ nodes: [doc("t", "고립문서"), doc("a", "문서A")], edges: [] });
      bodyRows = [
        { id: "t", markdown: "비밀 프로젝트 코드명" },
        { id: "hidden", markdown: "비밀 프로젝트 코드명" },
      ];
      m(visibleOnly).mockImplementation((_i: unknown, r: { id: string }[]) => r.filter((x) => x.id !== "hidden"));
      await POST(req({ limit: 1, dryRun: true }));
      const cands = candidatesOf(m(complete).mock.calls[0][0] as string);
      expect(cands).toEqual(["a"]);
    });
  });
});
