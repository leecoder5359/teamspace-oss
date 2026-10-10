import { describe, expect, it } from "vitest";
import { resolveMermaidTheme } from "./mermaidTheme";

describe("resolveMermaidTheme", () => {
  it("data-theme 속성이 OS 설정보다 우선한다", () => {
    expect(resolveMermaidTheme("dark", false)).toBe("dark");
    expect(resolveMermaidTheme("light", true)).toBe("default");
  });
  it("속성이 없거나 모르는 값이면 prefers-color-scheme 을 따른다", () => {
    expect(resolveMermaidTheme(undefined, true)).toBe("dark");
    expect(resolveMermaidTheme(null, false)).toBe("default");
    expect(resolveMermaidTheme("", true)).toBe("dark");
  });
});
