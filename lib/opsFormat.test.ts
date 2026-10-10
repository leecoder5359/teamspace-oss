import { describe, expect, it } from "vitest";
import { formatTokens } from "./opsFormat";

describe("formatTokens", () => {
  it("null/undefined 는 — 로 표시", () => {
    expect(formatTokens(null)).toBe("—");
    expect(formatTokens(undefined)).toBe("—");
  });
  it("0 은 0, 큰 수는 천단위 구분", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1234567)).toBe("1,234,567");
  });
});
