import { describe, it, expect } from "vitest";
import { parseExpansion, mergeTerms } from "./semsearch";

describe("parseExpansion", () => {
  it("JSON 문자열 배열을 소문자·트림·중복/짧은토큰 제거로 파싱", () => {
    expect(parseExpansion('["배포","릴리스","Deploy","deploy"," a "]')).toEqual(["배포", "릴리스", "deploy"]);
  });

  it("코드펜스·설명이 섞여도 첫 배열만", () => {
    expect(parseExpansion('관련어:\n```json\n["롤백","rollback"]\n```')).toEqual(["롤백", "rollback"]);
  });

  it("문자열 아닌 항목 제외, 깨진/배열아님 → 빈 배열", () => {
    expect(parseExpansion('["ok", 3, null, "ok2"]')).toEqual(["ok", "ok2"]);
    expect(parseExpansion("nope")).toEqual([]);
    expect(parseExpansion("[broken")).toEqual([]);
  });
});

describe("mergeTerms", () => {
  it("원 토큰 우선·소문자 중복 제거·짧은토큰 제거", () => {
    expect(mergeTerms(["배포", "deploy"], ["Deploy", "롤백", "x"])).toEqual(["배포", "deploy", "롤백"]);
  });

  it("빈 확장도 안전", () => {
    expect(mergeTerms(["워커"], [])).toEqual(["워커"]);
  });
});
