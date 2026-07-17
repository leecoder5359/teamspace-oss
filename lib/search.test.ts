import { describe, it, expect } from "vitest";
import { snippet } from "@/lib/search";

describe("snippet", () => {
  it("매칭 주변을 잘라 …로 감싼다", () => {
    const text = "a".repeat(60) + " 검색어 여기 " + "b".repeat(60);
    const s = snippet(text, "검색어", 30);
    expect(s).toContain("검색어");
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
  });
  it("대소문자 무시", () => {
    expect(snippet("Hello WORLD foo", "world", 40)).toContain("WORLD");
  });
  it("줄바꿈은 공백으로", () => {
    expect(snippet("줄1\n줄2 키워드 줄3", "키워드", 40)).not.toContain("\n");
  });
  it("매칭 없으면 앞부분", () => {
    expect(snippet("처음부터 보여줘", "없는말", 5)).toBe("처음부터…");
  });
  it("짧으면 그대로", () => {
    expect(snippet("짧다", "x", 40)).toBe("짧다");
  });
});
