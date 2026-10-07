import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/pageGuard", () => ({ loadAccess: vi.fn(), visibleOnly: vi.fn() }));
vi.mock("@/lib/graphLoad", () => ({ loadGraph: vi.fn(), invalidateGraphCache: vi.fn() }));
vi.mock("@/lib/llm", () => ({ complete: vi.fn(), resolveProvider: () => "cli" }));
vi.mock("@/lib/prisma", () => ({
  prisma: { page: { findMany: vi.fn() }, graphEdge: { upsert: vi.fn() } },
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

describe("POST /api/graph/infer", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor" });
    m(loadAccess).mockResolvedValue({ idx: true });
    m(visibleOnly).mockImplementation((_i: unknown, r: unknown[]) => r);
    m(loadGraph).mockResolvedValue(G);
    m(prisma.page.findMany).mockResolvedValue([{ id: "w1d", markdown: "본문" }]);
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

  it("exclude: 제외한 문서는 건너뛰고 remaining 에 반영", async () => {
    m(loadGraph).mockResolvedValue({ nodes: [doc("w1d", "가문서"), doc("w2d", "나문서"), doc("w3d", "다문서")], edges: [] });
    m(prisma.page.findMany).mockResolvedValue([]);
    const j = await (await POST(req({ limit: 1, dryRun: true, exclude: ["w1d"] }))).json();
    expect(j.processed.map((p: { id: string }) => p.id)).toEqual(["w2d"]);
    expect(j.remaining).toBe(1);
  });

  it("exclude 검증: 문자열 아닌 값은 무시, 5000 초과는 400", async () => {
    m(loadGraph).mockResolvedValue({ nodes: [doc("w1d", "가문서"), doc("w2d", "나문서")], edges: [] });
    const ok = await (await POST(req({ limit: 1, dryRun: true, exclude: [1, null, "w1d"] }))).json();
    expect(ok.processed.map((p: { id: string }) => p.id)).toEqual(["w2d"]);
    const bad = await POST(req({ exclude: Array.from({ length: 5001 }, (_, i) => `x${i}`) }));
    expect(bad.status).toBe(400);
  });

  it("limit 999 → 최대 20개", async () => {
    const nodes = Array.from({ length: 25 }, (_, i) => doc(`d${String(i).padStart(2, "0")}`, `문서${String(i).padStart(2, "0")}`));
    m(loadGraph).mockResolvedValue({ nodes, edges: [] });
    m(prisma.page.findMany).mockResolvedValue([]);
    const j = await (await POST(req({ limit: 999, dryRun: true }))).json();
    expect(j.processed).toHaveLength(20);
    expect(j.remaining).toBe(5);
  });

  describe("A1: 후보 상한·사전 순위", () => {
    const many = () => Array.from({ length: 100 }, (_, i) => doc(`d${String(i).padStart(3, "0")}`, `잡문서${String(i).padStart(3, "0")}`));
    const candidatesOf = (prompt: string) => prompt.split("[후보] (id<TAB>제목)\n")[1].split("\n").filter(Boolean).map((l) => l.split("\t")[0]);

    it("후보는 최대 60개, 가장 비슷한 문서가 (제목순으로 뒤여도) 들어간다", async () => {
      const nodes = [doc("t", "고립문서"), ...many(), doc("zz", "쿠버네티스 배포 파이프라인")];
      m(loadGraph).mockResolvedValue({ nodes, edges: [{ from: "d000", to: "d001", kind: "link", kinds: ["link"], tag: "추출" }] });
      m(prisma.page.findMany).mockResolvedValue([
        { id: "t", markdown: "쿠버네티스 배포 파이프라인 정리" },
        { id: "zz", markdown: "쿠버네티스 배포 파이프라인 단계" },
      ]);
      await POST(req({ limit: 1, dryRun: true }));
      const cands = candidatesOf(m(complete).mock.calls[0][0] as string);
      expect(cands.length).toBeLessThanOrEqual(60);
      expect(cands.length).toBe(60);
      expect(cands[0]).toBe("zz");
      expect(cands).not.toContain("t");
      expect(prisma.page.findMany).toHaveBeenCalledTimes(1); // 본문은 한 번에
    });

    it("그래프 노드지만 visibleOnly 가 거른 문서: 본문이 프롬프트·순위에 안 쓰인다", async () => {
      const nodes = [doc("t", "고립문서"), ...many(), doc("zz", "힛든문서")];
      m(loadGraph).mockResolvedValue({ nodes, edges: [{ from: "d000", to: "d001", kind: "link", kinds: ["link"], tag: "추출" }] });
      m(prisma.page.findMany).mockResolvedValue([
        { id: "t", markdown: "쿠버네티스 배포 파이프라인 정리" },
        { id: "zz", markdown: "쿠버네티스 배포 파이프라인 단계 극비본문토큰" },
      ]);
      m(visibleOnly).mockImplementation((_i: unknown, r: { id: string }[]) => r.filter((x) => x.id !== "zz"));
      await POST(req({ limit: 1, dryRun: true }));
      const prompt = m(complete).mock.calls[0][0] as string;
      expect(prompt).not.toContain("극비본문토큰");
      // 색인에 있었다면 가장 비슷해 1순위였을 문서 — 제목순 채움(100개 중 60)에선 밀려난다
      expect(candidatesOf(prompt)).not.toContain("zz");
    });

    it("못 보는 문서(그래프에 없음·visibleOnly 가 거른 행)는 후보·색인에 안 들어간다", async () => {
      m(loadGraph).mockResolvedValue({ nodes: [doc("t", "고립문서"), doc("a", "문서A")], edges: [] });
      m(prisma.page.findMany).mockResolvedValue([
        { id: "t", markdown: "비밀 프로젝트 코드명" },
        { id: "hidden", markdown: "비밀 프로젝트 코드명" },
      ]);
      m(visibleOnly).mockImplementation((_i: unknown, r: { id: string }[]) => r.filter((x) => x.id !== "hidden"));
      await POST(req({ limit: 1, dryRun: true }));
      const cands = candidatesOf(m(complete).mock.calls[0][0] as string);
      expect(cands).toEqual(["a"]);
    });
  });
});
