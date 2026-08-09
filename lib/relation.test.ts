import { describe, it, expect } from "vitest";
import { normalizeIds, toggleId, partitionKnown, relationLabel, sameIds, isDoneLabel, blockingIds } from "@/lib/relation";

describe("normalizeIds — 저장된 값을 id 배열로", () => {
  it("배열은 그대로(공백·빈값 제거)", () => {
    expect(normalizeIds(["a", "", "  b  ", null, "c"])).toEqual(["a", "b", "c"]);
  });

  it("문자열 하나도 받는다(단일값으로 저장된 옛 데이터)", () => {
    expect(normalizeIds("a")).toEqual(["a"]);
  });

  it("중복은 첫 등장 순서로 접는다", () => {
    expect(normalizeIds(["b", "a", "b"])).toEqual(["b", "a"]);
  });

  it("값이 없으면 빈 배열", () => {
    for (const v of [null, undefined, "", [], 42, {}]) expect(normalizeIds(v)).toEqual([]);
  });
});

describe("toggleId", () => {
  it("없으면 넣고 있으면 뺀다", () => {
    expect(toggleId(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleId(["a", "b"], "a")).toEqual(["b"]);
  });

  it("원본을 건드리지 않는다", () => {
    const src = ["a"];
    toggleId(src, "b");
    expect(src).toEqual(["a"]);
  });
});

describe("partitionKnown — 대상 보드에 실재하는 id 만", () => {
  it("모르는 id 를 갈라낸다", () => {
    const r = partitionKnown(["a", "zzz", "b"], new Set(["a", "b", "c"]));
    expect(r.known).toEqual(["a", "b"]);
    expect(r.unknown).toEqual(["zzz"]);
  });

  it("전부 알면 unknown 은 빈 배열", () => {
    expect(partitionKnown(["a"], new Set(["a"])).unknown).toEqual([]);
  });
});

describe("relationLabel — 칩 표시", () => {
  const titles = new Map([
    ["a", "첫 태스크"],
    ["b", "둘째 태스크"],
    ["c", "셋째"],
  ]);
  const titleOf = (id: string) => titles.get(id) ?? null;

  it("최대 개수까지 보여주고 나머지는 개수로", () => {
    const r = relationLabel(["a", "b", "c"], titleOf, 2);
    expect(r.shown).toEqual(["첫 태스크", "둘째 태스크"]);
    expect(r.overflow).toBe(1);
  });

  it("제목을 못 찾으면 지워진 행으로 표시한다(조용히 빠지지 않는다)", () => {
    const r = relationLabel(["a", "없는id"], titleOf, 5);
    expect(r.shown).toEqual(["첫 태스크", "(삭제된 행)"]);
    expect(r.overflow).toBe(0);
  });

  it("빈 값이면 아무것도 없다", () => {
    expect(relationLabel([], titleOf)).toEqual({ shown: [], overflow: 0 });
  });
});

describe("sameIds", () => {
  it("순서까지 같아야 같다(정렬은 사용자가 정한 순서다)", () => {
    expect(sameIds(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameIds(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameIds(["a"], ["a", "b"])).toBe(false);
  });
});

describe("의존관계 표시 (C6)", () => {
  it("완료를 뜻하는 이름들을 알아본다", () => {
    for (const s of ["완료", "Done", "done ", "closed", "해결됨", "끝"]) expect(isDoneLabel(s)).toBe(true);
    for (const s of ["진행 중", "할 일", "In Progress", "", null, undefined]) expect(isDoneLabel(s)).toBe(false);
  });

  it("안 끝난 선행만 남긴다", () => {
    const status = new Map([
      ["a", "완료"],
      ["b", "진행 중"],
      ["c", null],
    ]);
    expect(blockingIds(["a", "b", "c"], (id) => status.get(id) ?? null)).toEqual(["b", "c"]);
  });

  it("선행이 전부 끝났으면 막혀 있지 않다", () => {
    expect(blockingIds(["a"], () => "완료")).toEqual([]);
  });

  it("선행이 없으면 빈 배열", () => {
    expect(blockingIds([], () => null)).toEqual([]);
  });
});
