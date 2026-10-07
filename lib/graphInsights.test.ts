import { describe, it, expect } from "vitest";
import type { KGraph, GNode, GEdge, EdgeKind } from "./knowledgeGraph";
import { KIND_TAG } from "./knowledgeGraph";
import { degreeMap, hubs, communities, neighbors, subgraph, weakDocs, renderKnowledgeMap } from "./graphInsights";

const N = (id: string, type: GNode["type"] = "doc", projectId: string | null = null): GNode => ({ id, title: `T-${id}`, type, href: `/p/${id}`, projectId });
const E = (from: string, to: string, kind: EdgeKind = "link"): GEdge => ({ from, to, kind, kinds: [kind], tag: KIND_TAG[kind] });

// 군집 A: a-b-c 삼각형, 군집 B: x-y, 다리 c-x 없음. 프로젝트 P 가 a,x 를 contains.
const g: KGraph = {
  nodes: [N("a"), N("b"), N("c"), N("x"), N("y"), N("z"), N("P", "project")],
  edges: [E("a", "b"), E("b", "c"), E("a", "c"), E("x", "y", "mention"), E("P", "a", "contains"), E("P", "x", "contains")],
};

describe("graphInsights", () => {
  it("degreeMap: 양방향 차수", () => {
    const d = degreeMap(g);
    expect(d.get("a")).toBe(3);
    expect(d.get("z") ?? 0).toBe(0);
  });

  it("hubs: 기본은 문서만, 차수 내림차순·동률은 제목순", () => {
    expect(hubs(g, 2).map((h) => h.node.id)).toEqual(["a", "b"]);
  });

  it("communities: 프로젝트 contains 는 무시, 크기 2 이상만, 크기 내림차순", () => {
    const c = communities(g);
    expect(c.map((x) => x.members.map((m) => m.id).sort())).toEqual([["a", "b", "c"], ["x", "y"]]);
    expect(c[0].rep.id).toBe("a");
  });

  it("communities: 문서 노드만(결정·레슨·태스크·리스크 제외)", () => {
    const mixed: KGraph = {
      nodes: [N("a"), N("b"), N("dec", "decision"), N("les", "lesson"), N("t", "task"), N("r", "risk")],
      edges: [E("a", "b"), E("a", "dec"), E("dec", "les"), E("les", "t"), E("t", "r")],
    };
    const ids = communities(mixed).flatMap((x) => x.members.map((m) => m.id)).sort();
    expect(ids).toEqual(["a", "b"]);
  });

  it("communities: 결정적이다(두 번 같은 결과)", () => {
    expect(communities(g)).toEqual(communities(g));
  });

  it("neighbors depth1: 방향·kind·tag", () => {
    const n = neighbors(g, "a");
    expect(n.find((x) => x.id === "b")).toMatchObject({ direction: "out", kind: "link", tag: "추출", hop: 1 });
    expect(n.find((x) => x.id === "P")).toMatchObject({ direction: "in", kind: "contains", hop: 1 });
  });

  it("neighbors depth2: 2홉 포함, 자기 자신 제외, depth 는 최대 2", () => {
    const n = neighbors(g, "b", 5);
    expect(n.find((x) => x.id === "P")?.hop).toBe(2);
    expect(n.find((x) => x.id === "b")).toBeUndefined();
    expect(n.find((x) => x.id === "y")).toBeUndefined(); // b→a→P→x→y 는 4홉
  });

  it("subgraph: 남은 노드 사이 간선만", () => {
    const s = subgraph(g, (n) => n.id !== "a");
    expect(s.edges.some((e) => e.from === "a" || e.to === "a")).toBe(false);
  });

  it("weakDocs: 프로젝트 contains 외 간선이 없는 문서", () => {
    expect(weakDocs(g).map((n) => n.id)).toEqual(["z"]);
    const g2: KGraph = { nodes: [N("q"), N("P", "project")], edges: [E("P", "q", "contains")] };
    expect(weakDocs(g2).map((n) => n.id)).toEqual(["q"]);
  });

  it("renderKnowledgeMap: 섹션 제목·허브·군집·안내 줄", () => {
    const lines = renderKnowledgeMap(g, { hubN: 2, commN: 1 });
    expect(lines[0]).toBe("## 지식 지도");
    expect(lines).toContain("- T-a (연결 3) `a`");
    expect(lines.some((l) => l.startsWith("- T-a 외 2건"))).toBe(true);
    expect(lines.at(-2)).toContain("graph_neighbors");
    // 군집 줄에는 다른 구성원을 하나만
    expect(lines).toContain("- T-a 외 2건 — T-b");
  });

  it("renderKnowledgeMap: 긴 제목은 40자(39자+…)로 줄이고 허브 줄에 id 를 백틱으로 낸다", () => {
    const long = "가".repeat(60);
    const g2: KGraph = { nodes: [{ ...N("q1"), title: long }, N("q2")], edges: [E("q1", "q2")] };
    const lines = renderKnowledgeMap(g2, { hubN: 1, commN: 1 });
    const hub = lines.find((l) => l.includes("(연결 1)"))!;
    expect(hub).toContain(`- ${"가".repeat(39)}… (연결 1) \`q1\``);
    expect(hub).not.toContain("가".repeat(40));
  });

  it("A6: neighbors depth 0·음수·NaN 은 1 로 취급", () => {
    const one = neighbors(g, "a", 1);
    expect(one.length).toBeGreaterThan(0);
    expect(neighbors(g, "a", 0)).toEqual(one);
    expect(neighbors(g, "a", -3)).toEqual(one);
    expect(neighbors(g, "a", Number.NaN)).toEqual(one);
  });
});
