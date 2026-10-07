import { describe, it, expect } from "vitest";
import { truncateLabel, isZoomedIn, selectLabelIds, LABEL_ZOOM_RATIO, LABEL_MAX_CHARS } from "@/lib/graphLabels";

describe("truncateLabel", () => {
  it("짧으면 그대로", () => expect(truncateLabel("가".repeat(LABEL_MAX_CHARS))).toBe("가".repeat(LABEL_MAX_CHARS)));
  it("20자 초과는 20자 + …", () => expect(truncateLabel("a".repeat(30))).toBe("a".repeat(20) + "…"));
});

describe("isZoomedIn", () => {
  it("보이는 폭이 전체의 35% 이하면 true", () => {
    expect(isZoomedIn(1200 * LABEL_ZOOM_RATIO, 1200)).toBe(true);
    expect(isZoomedIn(1200 * 0.5, 1200)).toBe(false);
    expect(isZoomedIn(1200, 1200)).toBe(false);
  });
});

describe("selectLabelIds", () => {
  const nodes = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, title: `t${i}` }));
  const deg = new Map(nodes.map((n, i) => [n.id, i]));
  const base = { nodes, deg, focus: null, visible: null, matches: null, zoomedIn: false };

  it("확대 전엔 차수 상위 15개만", () => {
    const s = selectLabelIds(base);
    expect(s.size).toBe(15);
    expect(s.has("n29")).toBe(true);
    expect(s.has("n15")).toBe(true);
    expect(s.has("n14")).toBe(false);
  });
  it("포커스·깊이 범위·검색 적중도 포함", () => {
    const s = selectLabelIds({ ...base, focus: "n0", visible: new Set(["n0", "n1"]), matches: new Set(["n2"]) });
    expect(["n0", "n1", "n2"].every((id) => s.has(id))).toBe(true);
    expect(s.size).toBe(18);
  });
  it("차수 동률은 제목 → id 순으로 결정적", () => {
    const ns = Array.from({ length: 20 }, (_, i) => ({ id: `i${19 - i}`, title: i < 10 ? `가${i}` : `나${i}` }));
    const d = new Map(ns.map((n) => [n.id, 1]));
    const a = selectLabelIds({ ...base, nodes: ns, deg: d });
    const b = selectLabelIds({ ...base, nodes: [...ns].reverse(), deg: d });
    expect([...a].sort()).toEqual([...b].sort());
    expect(a.size).toBe(15);
    expect(a.has("i19")).toBe(true); // 제목 '가0'
    expect(a.has("i0")).toBe(false); // 제목 '나19' — 맨 뒤
    const same = [{ id: "b", title: "x" }, { id: "a", title: "x" }];
    const one = selectLabelIds({ ...base, nodes: same, deg: new Map([["a", 1], ["b", 1]]) });
    expect(one.size).toBe(2);
  });
  it("차수 0 노드는 허브 라벨에서 제외(전부 0이면 허브 라벨 없음)", () => {
    expect(selectLabelIds({ ...base, deg: new Map() }).size).toBe(0);
    const s = selectLabelIds({ ...base, deg: new Map([["n3", 2]]) });
    expect([...s]).toEqual(["n3"]);
  });
  it("충분히 확대하면 전부", () => expect(selectLabelIds({ ...base, zoomedIn: true }).size).toBe(30));
});
