import { describe, expect, it } from "vitest";
import { estimateUsd, priceFor } from "./llmCost";

describe("priceFor", () => {
  it("모델 이름 부분 일치(대소문자 무시)", () => {
    expect(priceFor("claude-haiku-4-5")).toEqual({ inPerM: 1, outPerM: 5 });
    expect(priceFor("claude-sonnet-4-6")).toEqual({ inPerM: 3, outPerM: 15 });
    expect(priceFor("Claude-Opus-5-5")).toEqual({ inPerM: 5, outPerM: 25 });
  });
  it("모르는 모델은 null", () => {
    expect(priceFor("gpt-x")).toBeNull();
    expect(priceFor("")).toBeNull();
  });
});

describe("estimateUsd", () => {
  it("입력·출력 단가로 계산", () => {
    expect(estimateUsd("claude-sonnet-4-6", 1_000_000, 100_000)).toBeCloseTo(3 + 1.5);
    expect(estimateUsd("claude-haiku-4-5", 2000, 500)).toBeCloseTo(0.002 + 0.0025);
  });
  it("토큰이 둘 다 null 이면 null, 한쪽만 있으면 나머지는 0", () => {
    expect(estimateUsd("claude-haiku-4-5", null, null)).toBeNull();
    expect(estimateUsd("claude-haiku-4-5", 1_000_000, null)).toBeCloseTo(1);
  });
  it("모르는 모델이면 null", () => {
    expect(estimateUsd("mystery", 100, 100)).toBeNull();
  });
});
