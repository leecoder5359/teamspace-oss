import { describe, it, expect } from "vitest";
import { wouldCycle, buildRowTree, descendantIds, type TreeRow } from "@/lib/subitems";

const rows = (spec: [string, string | null][]): TreeRow[] =>
  spec.map(([id, parentRowId], i) => ({ id, parentRowId, position: i }));

describe("wouldCycle — 부모 지정이 순환을 만드나", () => {
  // a → b → c (a 가 최상위)
  const parentOf = new Map<string, string | null>([
    ["a", null],
    ["b", "a"],
    ["c", "b"],
  ]);

  it("자기 자신을 부모로 삼을 수 없다", () => {
    expect(wouldCycle("a", "a", parentOf)).toBe(true);
  });

  it("자손을 부모로 삼을 수 없다", () => {
    expect(wouldCycle("a", "c", parentOf)).toBe(true);
    expect(wouldCycle("b", "c", parentOf)).toBe(true);
  });

  it("관계없는 행은 괜찮다", () => {
    const p = new Map(parentOf);
    p.set("d", null);
    expect(wouldCycle("d", "c", p)).toBe(false);
    expect(wouldCycle("c", "d", p)).toBe(false);
  });

  it("부모 해제(null)는 언제나 괜찮다", () => {
    expect(wouldCycle("c", null, parentOf)).toBe(false);
  });

  it("이미 깨진 데이터(순환)에서도 무한루프에 빠지지 않는다", () => {
    const broken = new Map<string, string | null>([
      ["x", "y"],
      ["y", "x"],
    ]);
    expect(wouldCycle("z", "x", broken)).toBe(false);
  });
});

describe("buildRowTree — 부모 다음에 자식이 들여쓰기로", () => {
  it("자식을 부모 바로 아래에 놓는다", () => {
    const t = buildRowTree(rows([["a", null], ["b", null], ["a1", "a"]]));
    expect(t.map((r) => [r.id, r.depth])).toEqual([
      ["a", 0],
      ["a1", 1],
      ["b", 0],
    ]);
  });

  it("여러 단계도 순서대로", () => {
    const t = buildRowTree(rows([["a", null], ["a1", "a"], ["a1x", "a1"]]));
    expect(t.map((r) => [r.id, r.depth])).toEqual([
      ["a", 0],
      ["a1", 1],
      ["a1x", 2],
    ]);
  });

  it("부모가 이 목록에 없으면(필터로 잘림) 최상위로 올린다 — 행이 사라지면 안 된다", () => {
    const t = buildRowTree(rows([["orphan", "사라진부모"]]));
    expect(t.map((r) => [r.id, r.depth])).toEqual([["orphan", 0]]);
  });

  it("순환이 있어도 모든 행을 정확히 한 번씩 낸다", () => {
    const t = buildRowTree(rows([["x", "y"], ["y", "x"], ["z", null]]));
    expect(t).toHaveLength(3);
    expect(new Set(t.map((r) => r.id)).size).toBe(3);
  });

  it("접힌 부모의 자식은 빠진다", () => {
    const t = buildRowTree(rows([["a", null], ["a1", "a"], ["b", null]]), new Set(["a"]));
    expect(t.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("자식 유무를 알려준다(펼침 버튼을 그릴지 판단)", () => {
    const t = buildRowTree(rows([["a", null], ["a1", "a"], ["b", null]]));
    expect(t.find((r) => r.id === "a")!.hasChildren).toBe(true);
    expect(t.find((r) => r.id === "b")!.hasChildren).toBe(false);
  });

  it("position 순서를 지킨다", () => {
    const list: TreeRow[] = [
      { id: "b", parentRowId: null, position: 2 },
      { id: "a", parentRowId: null, position: 1 },
    ];
    expect(buildRowTree(list).map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("descendantIds", () => {
  it("모든 자손을 모은다", () => {
    const list = rows([["a", null], ["a1", "a"], ["a2", "a"], ["a1x", "a1"], ["b", null]]);
    expect(new Set(descendantIds("a", list))).toEqual(new Set(["a1", "a2", "a1x"]));
  });

  it("자식이 없으면 빈 배열", () => {
    expect(descendantIds("b", rows([["b", null]]))).toEqual([]);
  });
});

describe("buildRowTree — 입력 불변", () => {
  it("동결한 입력으로 호출해도 throw 없고 입력 순서가 그대로다", () => {
    const input = [
      { id: "b", parentRowId: null, position: 2 },
      { id: "b1", parentRowId: "b", position: 9 },
      { id: "b2", parentRowId: "b", position: 1 },
      { id: "a", parentRowId: null, position: 1 },
    ] as TreeRow[];
    const before = input.map((r) => r.id);
    Object.freeze(input);
    const out = buildRowTree(input).map((r) => r.id);
    expect(out).toEqual(["a", "b", "b2", "b1"]);
    expect(input.map((r) => r.id)).toEqual(before);
  });
});

describe("buildRowTree — rootCompare (열린 것만 기본 정렬)", () => {
  type R = TreeRow & { updatedAt: string };
  const input: R[] = [
    { id: "a", parentRowId: null, position: 0, updatedAt: "2026-01-01" },
    { id: "a1", parentRowId: "a", position: 1, updatedAt: "2026-09-01" },
    { id: "a2", parentRowId: "a", position: 2, updatedAt: "2026-02-01" },
    { id: "b", parentRowId: null, position: 3, updatedAt: "2026-05-01" },
  ];
  const desc = (x: R, y: R) => y.updatedAt.localeCompare(x.updatedAt);
  it("최상위만 비교 함수로 정렬하고 서브아이템은 부모 아래 position 순서를 지킨다", () => {
    const out = buildRowTree(input, undefined, { rootCompare: desc });
    expect(out.map((r) => [r.id, r.depth])).toEqual([["b", 0], ["a", 0], ["a1", 1], ["a2", 1]]);
  });
  it("비교 함수가 없으면 종전처럼 position 순서", () => {
    expect(buildRowTree(input).map((r) => r.id)).toEqual(["a", "a1", "a2", "b"]);
  });
});
