import { describe, it, expect } from "vitest";
import {
  matchRule,
  matchesGroup,
  filterKindOf,
  sanitizeFilterGroup,
  OPS_BY_KIND,
  type FilterGroup,
  type PropLike,
} from "@/lib/dbFilter";

describe("filterKindOf", () => {
  it("속성 타입을 필터 종류로 옮긴다", () => {
    expect(filterKindOf("select")).toBe("select");
    expect(filterKindOf("multiselect")).toBe("select");
    expect(filterKindOf("person")).toBe("select");
    expect(filterKindOf("number")).toBe("number");
    expect(filterKindOf("date")).toBe("date");
    expect(filterKindOf("checkbox")).toBe("checkbox");
  });

  it("모르는 타입은 text 로 — 어떤 속성이든 최소한 필터는 걸 수 있어야 한다", () => {
    expect(filterKindOf("relation")).toBe("text");
    expect(filterKindOf("무언가새로운타입")).toBe("text");
  });

  it("모든 종류에 쓸 수 있는 연산자가 하나 이상 있다", () => {
    for (const [, ops] of Object.entries(OPS_BY_KIND)) expect(ops.length).toBeGreaterThan(0);
  });
});

describe("matchRule — 빈값", () => {
  it("empty/notEmpty 는 null·빈문자열·빈배열을 비어 있다고 본다", () => {
    for (const v of [null, undefined, "", []]) {
      expect(matchRule(v, { propId: "p", op: "empty" }, "text")).toBe(true);
      expect(matchRule(v, { propId: "p", op: "notEmpty" }, "text")).toBe(false);
    }
    expect(matchRule("값", { propId: "p", op: "empty" }, "text")).toBe(false);
    expect(matchRule(0, { propId: "p", op: "notEmpty" }, "number")).toBe(true); // 0 은 빈값이 아니다
  });
});

describe("matchRule — 텍스트", () => {
  const t = (op: "contains" | "notContains" | "eq" | "ne", value: string, v: unknown) =>
    matchRule(v, { propId: "p", op, value }, "text");

  it("포함·미포함은 대소문자를 무시한다", () => {
    expect(t("contains", "abc", "xxABCxx")).toBe(true);
    expect(t("notContains", "abc", "xxABCxx")).toBe(false);
  });

  it("같음은 전체 일치", () => {
    expect(t("eq", "abc", "abc")).toBe(true);
    expect(t("eq", "abc", "abcd")).toBe(false);
    expect(t("ne", "abc", "abcd")).toBe(true);
  });

  it("배열 값은 이어붙여 검색한다(multiselect 를 텍스트로 볼 때)", () => {
    expect(t("contains", "나", ["가", "나"])).toBe(true);
  });
});

describe("matchRule — 숫자·날짜", () => {
  it("숫자 비교", () => {
    expect(matchRule(5, { propId: "p", op: "gt", value: 3 }, "number")).toBe(true);
    expect(matchRule(5, { propId: "p", op: "lt", value: 3 }, "number")).toBe(false);
    expect(matchRule("5", { propId: "p", op: "eq", value: "5" }, "number")).toBe(true);
  });

  it("숫자로 못 읽는 값은 통과시키지 않는다 — 조용히 새면 필터가 걸린 줄 알게 된다", () => {
    expect(matchRule("숫자아님", { propId: "p", op: "gt", value: 1 }, "number")).toBe(false);
    expect(matchRule(null, { propId: "p", op: "gt", value: 1 }, "number")).toBe(false);
  });

  it("날짜 이전·이후", () => {
    expect(matchRule("2026-08-10", { propId: "p", op: "gt", value: "2026-08-01" }, "date")).toBe(true);
    expect(matchRule("2026-07-10", { propId: "p", op: "lt", value: "2026-08-01" }, "date")).toBe(true);
    expect(matchRule("2026-08-10", { propId: "p", op: "lt", value: "2026-08-01" }, "date")).toBe(false);
  });

  it("날짜로 못 읽으면 false", () => {
    expect(matchRule("어제", { propId: "p", op: "lt", value: "2026-08-01" }, "date")).toBe(false);
  });
});

describe("matchRule — select", () => {
  it("단일값 같음·다름", () => {
    expect(matchRule("opt1", { propId: "p", op: "eq", value: "opt1" }, "select")).toBe(true);
    expect(matchRule("opt2", { propId: "p", op: "ne", value: "opt1" }, "select")).toBe(true);
  });

  it("다중값은 포함 여부로 본다", () => {
    expect(matchRule(["a", "b"], { propId: "p", op: "eq", value: "b" }, "select")).toBe(true);
    expect(matchRule(["a", "b"], { propId: "p", op: "ne", value: "c" }, "select")).toBe(true);
  });
});

describe("matchRule — 체크박스", () => {
  it("checked/unchecked", () => {
    expect(matchRule(true, { propId: "p", op: "checked" }, "checkbox")).toBe(true);
    expect(matchRule(false, { propId: "p", op: "checked" }, "checkbox")).toBe(false);
    expect(matchRule(undefined, { propId: "p", op: "unchecked" }, "checkbox")).toBe(true);
  });
});

describe("matchRule — 미완성 규칙", () => {
  it("값이 필요한 연산자인데 값이 비면 통과시킨다(작성 중인 규칙이 결과를 0건으로 만들지 않게)", () => {
    expect(matchRule("아무거나", { propId: "p", op: "contains", value: "" }, "text")).toBe(true);
    expect(matchRule(5, { propId: "p", op: "gt", value: null }, "number")).toBe(true);
  });
});

describe("matchesGroup", () => {
  const properties: PropLike[] = [
    { id: "title", type: "text" },
    { id: "status", type: "select" },
    { id: "due", type: "date" },
    { id: "done", type: "checkbox" },
  ];
  const row = { title: "배포 준비", status: "s1", due: "2026-08-20", done: false };

  it("규칙이 없으면 전부 통과", () => {
    expect(matchesGroup(row, properties, null)).toBe(true);
    expect(matchesGroup(row, properties, { conj: "and", rules: [] })).toBe(true);
  });

  it("and 는 전부 만족해야 한다", () => {
    const g: FilterGroup = {
      conj: "and",
      rules: [
        { propId: "title", op: "contains", value: "배포" },
        { propId: "status", op: "eq", value: "s1" },
      ],
    };
    expect(matchesGroup(row, properties, g)).toBe(true);
    g.rules[1].value = "s2";
    expect(matchesGroup(row, properties, g)).toBe(false);
  });

  it("or 는 하나만 맞아도 된다", () => {
    const g: FilterGroup = {
      conj: "or",
      rules: [
        { propId: "title", op: "contains", value: "없는말" },
        { propId: "done", op: "unchecked" },
      ],
    };
    expect(matchesGroup(row, properties, g)).toBe(true);
  });

  it("지워진 속성을 가리키는 규칙은 무시한다 — 뷰가 통째로 빈 화면이 되면 이유를 알 수 없다", () => {
    const g: FilterGroup = { conj: "and", rules: [{ propId: "삭제된속성", op: "eq", value: "x" }] };
    expect(matchesGroup(row, properties, g)).toBe(true);
  });

  it("유효한 규칙과 사라진 규칙이 섞이면 유효한 것만 본다", () => {
    const g: FilterGroup = {
      conj: "and",
      rules: [
        { propId: "삭제된속성", op: "eq", value: "x" },
        { propId: "title", op: "contains", value: "없는말" },
      ],
    };
    expect(matchesGroup(row, properties, g)).toBe(false);
  });
});

describe("sanitizeFilterGroup", () => {
  it("정상 입력을 통과시킨다", () => {
    expect(sanitizeFilterGroup({ conj: "or", rules: [{ propId: "p", op: "eq", value: "v" }] })).toEqual({
      conj: "or",
      rules: [{ propId: "p", op: "eq", value: "v" }],
    });
  });

  it("모르는 연산자·빈 propId·객체 값은 버린다", () => {
    const r = sanitizeFilterGroup({
      conj: "and",
      rules: [
        { propId: "p", op: "드롭테이블" },
        { propId: "", op: "eq", value: "v" },
        { propId: "q", op: "eq", value: { nested: true } },
      ],
    });
    expect(r).toEqual({ conj: "and", rules: [{ propId: "q", op: "eq", value: null }] });
  });

  it("conj 가 이상하면 and 로 떨어진다", () => {
    expect(sanitizeFilterGroup({ conj: "xor", rules: [] })?.conj).toBe("and");
  });

  it("객체가 아니면 null", () => {
    expect(sanitizeFilterGroup("문자열")).toBeNull();
    expect(sanitizeFilterGroup(null)).toBeNull();
  });
});
