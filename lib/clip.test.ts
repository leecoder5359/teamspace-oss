import { describe, it, expect } from "vitest";
import { parseClassification, buildClipMarkdown } from "./clip";

describe("parseClassification", () => {
  const ids = ["p1", "p2"];

  it("유효 projectId + summary 파싱", () => {
    expect(parseClassification('{"projectId":"p2","summary":"요약입니다."}', ids)).toEqual({
      projectId: "p2",
      summary: "요약입니다.",
    });
  });

  it("코드펜스·설명이 섞여도 첫 객체만", () => {
    expect(parseClassification('결과:\n```json\n{"projectId":"p1","summary":"가"}\n```', ids)).toEqual({
      projectId: "p1",
      summary: "가",
    });
  });

  it("목록에 없는 id(환각)·빈 id 는 null 로", () => {
    expect(parseClassification('{"projectId":"p9","summary":"s"}', ids).projectId).toBeNull();
    expect(parseClassification('{"projectId":"","summary":"s"}', ids).projectId).toBeNull();
  });

  it("깨진/객체아님 → 빈 결과", () => {
    expect(parseClassification("nope", ids)).toEqual({ projectId: null, summary: "" });
    expect(parseClassification("{broken", ids)).toEqual({ projectId: null, summary: "" });
  });
});

describe("buildClipMarkdown", () => {
  it("제목·출처·요약·본문을 조합", () => {
    const md = buildClipMarkdown("글 제목", "https://x.com/a", "한 줄 요약", "원문 본문");
    expect(md).toContain("# 글 제목");
    expect(md).toContain("> 출처: https://x.com/a");
    expect(md).toContain("한 줄 요약");
    expect(md).toContain("원문 본문");
  });

  it("출처·요약 없이도 안전", () => {
    const md = buildClipMarkdown("제목", "", "", "본문만");
    expect(md).toContain("# 제목");
    expect(md).not.toContain("출처:");
    expect(md).toContain("본문만");
  });
});
