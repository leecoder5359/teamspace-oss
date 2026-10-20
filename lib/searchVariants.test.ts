import { describe, it, expect } from "vitest";
import { mergeVariantRows, queryVariants } from "./searchVariants";

describe("queryVariants", () => {
  it("공백 없는 3~12자 질의는 원문 + 한 칸 삽입 변형", () => {
    expect(queryVariants("인증코어")).toEqual(["인증코어", "인 증코어", "인증 코어", "인증코 어"]);
  });
  it("공백이 있으면 원문 + 공백 제거본", () => {
    expect(queryVariants("인증 코어")).toEqual(["인증 코어", "인증코어"]);
  });
  it("원문이 항상 첫 번째, 중복 없음", () => {
    const v = queryVariants("a  b");
    expect(v[0]).toBe("a  b");
    expect(new Set(v).size).toBe(v.length);
  });
  it("2자 이하·13자 이상은 삽입 변형 없음", () => {
    expect(queryVariants("배포")).toEqual(["배포"]);
    expect(queryVariants("가".repeat(13))).toEqual(["가".repeat(13)]);
  });
  it("최대 8개", () => {
    expect(queryVariants("가나다라마바사아자차카타").length).toBeLessThanOrEqual(8);
  });
  it("빈 질의는 빈 배열", () => {
    expect(queryVariants("  ")).toEqual([]);
  });
});

describe("mergeVariantRows", () => {
  const r = (id: string, tag = "") => ({ id, tag });

  it("원문이 충분하면 원문만 돌려준다", () => {
    expect(mergeVariantRows([r("a")], [r("b")], true)).toEqual([r("a")]);
  });

  it("모자라면 원문 먼저, 변형은 id 중복을 뺀 뒤 순서대로", () => {
    expect(mergeVariantRows([r("a", "orig"), r("b")], [r("c"), r("a", "variant"), r("d")], false))
      .toEqual([r("a", "orig"), r("b"), r("c"), r("d")]);
  });

  it("입력 배열을 바꾸지 않는다", () => {
    const first = [r("a")];
    const more = [r("b")];
    mergeVariantRows(first, more, false);
    expect(first).toEqual([r("a")]);
    expect(more).toEqual([r("b")]);
  });
});
