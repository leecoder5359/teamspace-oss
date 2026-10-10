import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openApiEnabled, openApiStartupWarning } from "./openApi";

describe("openApiEnabled", () => {
  it("true + development → 켜진다", () => {
    expect(openApiEnabled("true", "development")).toBe(true);
  });
  it("true + test → 켜진다(테스트는 비-production)", () => {
    expect(openApiEnabled("true", "test")).toBe(true);
  });
  it("true + production → 무시된다", () => {
    expect(openApiEnabled("true", "production")).toBe(false);
  });
  it("미설정/그 외 값 → 항상 꺼진다", () => {
    expect(openApiEnabled(undefined, "development")).toBe(false);
    expect(openApiEnabled("false", "development")).toBe(false);
    expect(openApiEnabled("1", "production")).toBe(false);
  });
  it("인자 없이 부르면 process.env 를 읽는다", () => {
    const prev = { open: process.env.AUTH_OPEN_API };
    try {
      process.env.AUTH_OPEN_API = "true";
      expect(openApiEnabled()).toBe(process.env.NODE_ENV !== "production");
      delete process.env.AUTH_OPEN_API;
      expect(openApiEnabled()).toBe(false);
    } finally {
      if (prev.open === undefined) delete process.env.AUTH_OPEN_API;
      else process.env.AUTH_OPEN_API = prev.open;
    }
  });
  it("기본값은 정적 process.env.X 참조다(Next 가 엣지 번들에 인라인하도록)", () => {
    const src = readFileSync(new URL("./openApi.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/=\s*process\.env\s*[),]/);
    expect(src.match(/= process\.env\.AUTH_OPEN_API/g)?.length).toBe(2);
    expect(src.match(/= process\.env\.NODE_ENV/g)?.length).toBe(2);
  });
});

describe("openApiStartupWarning", () => {
  it("true + development → 위험 경고", () => {
    expect(openApiStartupWarning("true", "development")).toContain("토큰 없이 누구나 admin");
  });
  it("true + production → '무시' 경고", () => {
    expect(openApiStartupWarning("true", "production")).toContain("무시");
  });
  it("미설정 → null", () => {
    expect(openApiStartupWarning(undefined, "production")).toBeNull();
    expect(openApiStartupWarning(undefined, "development")).toBeNull();
  });
});
