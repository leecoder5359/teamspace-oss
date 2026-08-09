import { describe, it, expect } from "vitest";
import { computeLayout, degrees, adjacency, withinDepth } from "@/lib/graphLayout";

const W = 1200;
const H = 720;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe("computeLayout", () => {
  it("모든 노드에 좌표를 주고 화면 안에 둔다", () => {
    const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}` }));
    const pos = computeLayout(nodes, [], { width: W, height: H });
    expect(pos.size).toBe(12);
    for (const p of pos.values()) {
      expect(p.x).toBeGreaterThanOrEqual(30);
      expect(p.x).toBeLessThanOrEqual(W - 30);
      expect(p.y).toBeGreaterThanOrEqual(30);
      expect(p.y).toBeLessThanOrEqual(H - 30);
      expect(Number.isFinite(p.x)).toBe(true);
    }
  });

  it("결정적이다 — 같은 입력이면 같은 좌표", () => {
    const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const edges = [{ from: "a", to: "b" }];
    const p1 = computeLayout(nodes, edges);
    const p2 = computeLayout(nodes, edges);
    for (const id of ["a", "b", "c"]) {
      expect(p1.get(id)).toEqual(p2.get(id));
    }
  });

  it("연결된 쌍이 연결 안 된 쌍보다 가깝다 — 군집이 생긴다", () => {
    // 두 삼각형 군집이 다리 하나로 연결된 그래프
    const nodes = ["a1", "a2", "a3", "b1", "b2", "b3"].map((id) => ({ id }));
    const edges = [
      { from: "a1", to: "a2" },
      { from: "a2", to: "a3" },
      { from: "a3", to: "a1" },
      { from: "b1", to: "b2" },
      { from: "b2", to: "b3" },
      { from: "b3", to: "b1" },
      { from: "a1", to: "b1" },
    ];
    const pos = computeLayout(nodes, edges, { width: W, height: H });
    const withinA = dist(pos.get("a2")!, pos.get("a3")!);
    const across = dist(pos.get("a2")!, pos.get("b2")!);
    expect(withinA).toBeLessThan(across);
  });

  it("노드가 0개·1개여도 터지지 않는다", () => {
    expect(computeLayout([], []).size).toBe(0);
    const one = computeLayout([{ id: "solo" }], []);
    expect(one.size).toBe(1);
    expect(Number.isFinite(one.get("solo")!.x)).toBe(true);
  });

  it("존재하지 않는 노드를 가리키는 간선·자기참조를 무시한다", () => {
    const pos = computeLayout([{ id: "a" }, { id: "b" }], [
      { from: "a", to: "ghost" },
      { from: "a", to: "a" },
    ]);
    expect(pos.size).toBe(2);
    expect(Number.isFinite(pos.get("a")!.x)).toBe(true);
  });

  it("완전히 겹친 위치에서도 NaN 이 나오지 않는다(난수 없이 분리)", () => {
    const nodes = Array.from({ length: 5 }, (_, i) => ({ id: `n${i}` }));
    const pos = computeLayout(nodes, [], { width: 100, height: 100, iterations: 60 });
    for (const p of pos.values()) {
      expect(Number.isNaN(p.x)).toBe(false);
      expect(Number.isNaN(p.y)).toBe(false);
    }
  });
});

describe("degrees / adjacency / withinDepth", () => {
  const nodes = ["a", "b", "c", "d"].map((id) => ({ id }));
  const edges = [
    { from: "a", to: "b" },
    { from: "b", to: "c" },
  ];

  it("차수는 무방향으로 센다", () => {
    const deg = degrees(nodes, edges);
    expect(deg.get("a")).toBe(1);
    expect(deg.get("b")).toBe(2);
    expect(deg.get("d")).toBe(0);
  });

  it("이웃은 양방향으로 잡힌다", () => {
    const adj = adjacency(edges);
    expect([...(adj.get("b") ?? [])].sort()).toEqual(["a", "c"]);
  });

  it("깊이 1 은 직접 이웃까지, 깊이 2 는 그 너머까지", () => {
    const adj = adjacency(edges);
    expect([...withinDepth(adj, "a", 1)].sort()).toEqual(["a", "b"]);
    expect([...withinDepth(adj, "a", 2)].sort()).toEqual(["a", "b", "c"]);
    // 고립 노드는 자기 자신만
    expect([...withinDepth(adj, "d", 3)]).toEqual(["d"]);
  });
});
