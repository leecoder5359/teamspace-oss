import { describe, it, expect } from "vitest";
import { buildRelatedPrompt, parseRelated } from "./graphInfer";

describe("graphInfer", () => {
  it("프롬프트: 본문은 2000자로 자르고 후보는 id\\t제목 줄", () => {
    const p = buildRelatedPrompt({ title: "대상", body: "☃".repeat(5000) }, [{ id: "c1", title: "후보1" }]);
    expect(p).toContain("# 대상");
    expect(p).toContain("c1\t후보1");
    expect(p.match(/☃/g)!.length).toBe(2000);
  });

  it("파싱: 후보 밖 id·중복 버리고 최대 3개", () => {
    const ids = new Set(["c1", "c2", "c3", "c4"]);
    const raw = `설명\n[{"id":"c1","reason":"같은 기능"},{"id":"zz","reason":"x"},{"id":"c1","reason":"dup"},{"id":"c2","reason":""},{"id":"c3","reason":"r"},{"id":"c4","reason":"r"}]`;
    expect(parseRelated(raw, ids)).toEqual([
      { id: "c1", reason: "같은 기능" }, { id: "c2", reason: "" }, { id: "c3", reason: "r" },
    ]);
  });

  it("프롬프트: 제목의 탭·개행은 공백 하나로", () => {
    const p = buildRelatedPrompt({ title: "대\n상\t문서", body: "" }, [{ id: "c1", title: "후\t보\n1" }]);
    expect(p).toContain("# 대 상 문서");
    expect(p).toContain("c1\t후 보 1");
  });

  it("파싱: reason 은 200자로 자름", () => {
    const [r] = parseRelated(`[{"id":"c1","reason":"${"이".repeat(500)}"}]`, new Set(["c1"]));
    expect(r.reason).toHaveLength(200);
  });

  it("파싱: 깨진 JSON 은 빈 배열", () => {
    expect(parseRelated("[{oops", new Set(["c1"]))).toEqual([]);
  });
});
