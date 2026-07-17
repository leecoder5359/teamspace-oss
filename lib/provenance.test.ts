import { describe, it, expect } from "vitest";
import { parseProvenance, countTags } from "./provenance";

describe("parseProvenance", () => {
  it("유효 tag 만 채택·트림", () => {
    const text = JSON.stringify([
      { claim: " 워커는 DB 폴링한다 ", tag: "추출", note: " 본문 명시 " },
      { claim: "확장성이 좋을 것이다", tag: "추론", note: "유추" },
      { claim: "잘 될 듯", tag: "모호", note: "" },
    ]);
    const out = parseProvenance(text);
    expect(out).toEqual([
      { claim: "워커는 DB 폴링한다", tag: "추출", note: "본문 명시" },
      { claim: "확장성이 좋을 것이다", tag: "추론", note: "유추" },
      { claim: "잘 될 듯", tag: "모호", note: "" },
    ]);
  });

  it("잘못된 tag·빈 claim 제외, 코드펜스 섞여도 첫 배열만", () => {
    const text = "```json\n" + JSON.stringify([
      { claim: "x", tag: "사실" },        // 잘못된 tag
      { claim: "", tag: "추출" },          // 빈 claim
      { claim: "유효", tag: "추출" },
    ]) + "\n```";
    expect(parseProvenance(text)).toEqual([{ claim: "유효", tag: "추출", note: "" }]);
  });

  it("cap 으로 개수 제한", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ claim: `c${i}`, tag: "추출" }));
    expect(parseProvenance(JSON.stringify(many), 5)).toHaveLength(5);
  });

  it("배열 아님/깨진 입력 → 빈 배열", () => {
    expect(parseProvenance("nope")).toEqual([]);
    expect(parseProvenance("[broken")).toEqual([]);
  });
});

describe("countTags", () => {
  it("태그별 집계", () => {
    const counts = countTags([
      { claim: "a", tag: "추출", note: "" },
      { claim: "b", tag: "추출", note: "" },
      { claim: "c", tag: "추론", note: "" },
    ]);
    expect(counts).toEqual({ 추출: 2, 추론: 1, 모호: 0 });
  });
});
