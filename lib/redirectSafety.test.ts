import { describe, it, expect } from "vitest";
import { safeCallbackPath } from "./redirectSafety";

describe("safeCallbackPath", () => {
  it("허용 - 내부 상대경로는 그대로 반환", () => {
    expect(safeCallbackPath("/setup/pair?code=abc")).toBe("/setup/pair?code=abc");
    expect(safeCallbackPath("/")).toBe("/");
    expect(safeCallbackPath("/a/b/c?x=1&y=2#frag")).toBe("/a/b/c?x=1&y=2#frag");
  });

  it("거부 - null/빈 문자열", () => {
    expect(safeCallbackPath(null)).toBe("/");
    expect(safeCallbackPath(undefined)).toBe("/");
    expect(safeCallbackPath("")).toBe("/");
  });

  it("거부 - 프로토콜 상대 URL(//evil.com)", () => {
    expect(safeCallbackPath("//evil.com")).toBe("/");
    expect(safeCallbackPath("//evil.com/path")).toBe("/");
  });

  it("거부 - 절대 URL", () => {
    expect(safeCallbackPath("https://evil.com")).toBe("/");
    expect(safeCallbackPath("http://evil.com")).toBe("/");
    expect(safeCallbackPath("http:evil")).toBe("/");
  });

  it("거부 - 백슬래시 변형(브라우저가 //evil.com 으로 정규화할 수 있는 입력)", () => {
    expect(safeCallbackPath("/\\evil.com")).toBe("/");
    expect(safeCallbackPath("/\\/evil")).toBe("/");
    expect(safeCallbackPath("\\\\evil")).toBe("/");
    expect(safeCallbackPath("\\evil.com")).toBe("/");
  });

  it("거부 - 슬래시로 시작하지 않는 경로", () => {
    expect(safeCallbackPath("evil.com")).toBe("/");
    expect(safeCallbackPath("setup/pair")).toBe("/");
  });

  it("거부 - 제어문자 포함", () => {
    expect(safeCallbackPath("/setup\n/pair")).toBe("/");
    expect(safeCallbackPath("/setup\r\n/pair")).toBe("/");
    expect(safeCallbackPath("/setup\t/pair")).toBe("/");
  });
});
