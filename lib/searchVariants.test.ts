import { describe, it, expect } from "vitest";
import { queryVariants } from "./searchVariants";

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
