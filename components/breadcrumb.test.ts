import { describe, it, expect } from "vitest";
import { pathOf } from "@/lib/pagesMeta";
const pages = [
  { id: "f", title: "인증·계정", parentId: null, projectId: "p" },
  { id: "d", title: "인증 코어 설계", parentId: "f", projectId: "p" },
  { id: "loop1", title: "a", parentId: "loop2", projectId: null },
  { id: "loop2", title: "b", parentId: "loop1", projectId: null },
];
describe("pathOf", () => {
  it("프로젝트 › 폴더 › 문서", () => {
    expect(pathOf(pages, [{ id: "p", name: "반장" }], "d").map((x) => x.label)).toEqual(["반장", "인증·계정", "인증 코어 설계"]);
    expect(pathOf(pages, [{ id: "p", name: "반장" }], "d")[0].href).toBe("/projects");
  });
  it("프로젝트 없으면 미분류, 순환은 끊는다", () => {
    const labels = pathOf(pages, [], "loop1").map((x) => x.label);
    expect(labels[0]).toBe("미분류");
    expect(labels.length).toBeLessThanOrEqual(4);
  });
});
