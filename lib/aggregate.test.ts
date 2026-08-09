import { describe, it, expect } from "vitest";
import { aggOptionsFor, computeAgg, formatAgg, AGG_LABEL, type AggFn } from "@/lib/aggregate";

describe("aggOptionsFor — 속성 타입이 허용하는 집계", () => {
  it("숫자는 합계·평균·최소·최대를 준다", () => {
    const o = aggOptionsFor("number");
    for (const f of ["sum", "avg", "min", "max"] as AggFn[]) expect(o).toContain(f);
  });

  it("체크박스는 체크 수·비율을 준다(합계는 의미 없다)", () => {
    const o = aggOptionsFor("checkbox");
    expect(o).toContain("checked");
    expect(o).toContain("percentChecked");
    expect(o).not.toContain("sum");
  });

  it("날짜는 처음·마지막", () => {
    const o = aggOptionsFor("date");
    expect(o).toContain("earliest");
    expect(o).toContain("latest");
    expect(o).not.toContain("avg");
  });

  it("모든 타입이 개수 계열은 갖는다", () => {
    for (const t of ["text", "number", "date", "select", "checkbox", "person", "relation"]) {
      const o = aggOptionsFor(t);
      expect(o).toContain("none");
      expect(o).toContain("filled");
      expect(o).toContain("empty");
    }
  });

  it("라벨이 모든 함수에 있다(화면에 빈 칸이 안 뜨도록)", () => {
    const all = new Set(["text", "number", "date", "select", "checkbox", "person", "relation"].flatMap(aggOptionsFor));
    for (const f of all) expect(AGG_LABEL[f]).toBeTruthy();
  });
});

describe("computeAgg — 숫자", () => {
  const nums = [3, 1, null, 5, "", 2];

  it("합계는 빈값을 0 으로 세지 않는다", () => {
    expect(computeAgg("sum", nums)).toBe(11);
  });

  it("평균은 **값이 있는 것만** 나눈다", () => {
    // 6개 중 값은 4개(3,1,5,2) → 11/4 = 2.75. 6으로 나누면 빈칸이 0점이 된다.
    expect(computeAgg("avg", nums)).toBeCloseTo(2.75, 6);
  });

  it("최소·최대", () => {
    expect(computeAgg("min", nums)).toBe(1);
    expect(computeAgg("max", nums)).toBe(5);
  });

  it("숫자 문자열도 센다(입력이 문자열로 저장된 경우)", () => {
    expect(computeAgg("sum", ["3", 2])).toBe(5);
  });

  it("값이 하나도 없으면 null(0 이 아니다)", () => {
    // 0 으로 보이면 "합이 0" 과 "값이 없음" 을 구분할 수 없다.
    for (const f of ["sum", "avg", "min", "max"] as AggFn[]) expect(computeAgg(f, [null, ""])).toBeNull();
  });
});

describe("computeAgg — 개수", () => {
  const vals = ["a", "", null, "b", 0, false, [], ["x"]];

  it("filled 는 '값이 있는' 것만", () => {
    // 0 과 false 는 값이다. 빈 문자열·null·빈 배열은 아니다.
    expect(computeAgg("filled", vals)).toBe(5);
  });

  it("empty 는 나머지", () => {
    expect(computeAgg("empty", vals)).toBe(3);
  });

  it("count 는 전체 행", () => {
    expect(computeAgg("count", vals)).toBe(8);
  });

  it("unique 는 서로 다른 값의 수(빈값 제외)", () => {
    expect(computeAgg("unique", ["a", "b", "a", "", null])).toBe(2);
  });
});

describe("computeAgg — 체크박스", () => {
  const vals = [true, false, true, null];

  it("체크·미체크 수", () => {
    expect(computeAgg("checked", vals)).toBe(2);
    expect(computeAgg("unchecked", vals)).toBe(2);
  });

  it("비율은 전체 행 기준 백분율", () => {
    expect(computeAgg("percentChecked", vals)).toBe(50);
  });

  it("행이 없으면 null", () => {
    expect(computeAgg("percentChecked", [])).toBeNull();
  });
});

describe("computeAgg — 날짜", () => {
  it("처음·마지막 날짜", () => {
    const vals = ["2026-08-09", null, "2026-01-02", "2026-12-31T10:00:00Z"];
    expect(computeAgg("earliest", vals)).toBe("2026-01-02");
    expect(computeAgg("latest", vals)).toBe("2026-12-31");
  });

  it("날짜가 없으면 null", () => {
    expect(computeAgg("earliest", ["아님", null])).toBeNull();
  });
});

describe("computeAgg — none", () => {
  it("계산하지 않는다", () => {
    expect(computeAgg("none", [1, 2])).toBeNull();
  });
});

describe("formatAgg — 화면 표기", () => {
  it("함수 이름과 값을 함께 보여준다", () => {
    expect(formatAgg("sum", 11)).toBe("합계 11");
    expect(formatAgg("filled", 3)).toBe("채워짐 3");
  });

  it("평균은 소수점 둘째 자리에서 끊는다", () => {
    expect(formatAgg("avg", 2.75)).toBe("평균 2.75");
    expect(formatAgg("avg", 2.6666666)).toBe("평균 2.67");
    expect(formatAgg("avg", 3)).toBe("평균 3");
  });

  it("비율에는 % 를 붙인다", () => {
    expect(formatAgg("percentChecked", 50)).toBe("체크 비율 50%");
  });

  it("값이 없으면 대시", () => {
    expect(formatAgg("sum", null)).toBe("—");
    expect(formatAgg("none", null)).toBe("");
  });

  it("큰 수는 천 단위 구분", () => {
    expect(formatAgg("sum", 1234567)).toBe("합계 1,234,567");
  });
});
