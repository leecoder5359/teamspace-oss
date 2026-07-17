import { describe, it, expect } from "vitest";
import { filterDocs, type DocFilterItem } from "@/lib/docFilter";

/* filterDocs: 문서함 목록을 제목 검색 + 프로젝트로 거르는 순수 함수.
   projectId 필터값: "" = 전체, "__none__" = 미분류(프로젝트 없음), 그 외 = 해당 프로젝트. */

const docs: (DocFilterItem & { id: string })[] = [
  { id: "1", title: "API 설계 문서", projectId: "iOS" },
  { id: "2", title: "회의록 2026", projectId: "iOS" },
  { id: "3", title: "릴리즈 노트", projectId: "core" },
  { id: "4", title: "임시 메모", projectId: null },
];

describe("filterDocs", () => {
  it("filters by title query (case-insensitive substring)", () => {
    const out = filterDocs(docs, { query: "api" });
    expect(out.map((d) => d.id)).toEqual(["1"]);
  });

  it("filters by projectId", () => {
    const out = filterDocs(docs, { projectId: "iOS" });
    expect(out.map((d) => d.id)).toEqual(["1", "2"]);
  });

  it("returns unassigned docs for the __none__ sentinel", () => {
    const out = filterDocs(docs, { projectId: "__none__" });
    expect(out.map((d) => d.id)).toEqual(["4"]);
  });

  it("returns all docs when query and projectId are empty", () => {
    const out = filterDocs(docs, { query: "  ", projectId: "" });
    expect(out.map((d) => d.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("combines title and project filters", () => {
    const out = filterDocs(docs, { query: "회의", projectId: "iOS" });
    expect(out.map((d) => d.id)).toEqual(["2"]);
  });
});
