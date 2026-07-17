import { describe, it, expect } from "vitest";
import { parseBacklogTitles } from "./parseBacklog";

describe("parseBacklogTitles", () => {
  it("extracts only the HIGH (높음) section top-level items, stripping numbers and backticks", () => {
    const md = [
      "# 백로그",
      "",
      "## 높음 (차별화 + 로드맵 연결)",
      "",
      "- [ ] **1. 양방향 위키링크 `[[...]]` + 백링크** (그룹 B)",
      "  - 하위 설명은 무시되어야 한다",
      "  - 의존: BlockNote",
      "",
      "- [ ] **2. 지식 인제스트→병합 파이프라인 + Q&A 쿼리** (그룹 A)",
      "",
      "## 중간",
      "",
      "- [ ] **4. 시맨틱(개념) 검색** (그룹 C)",
    ].join("\n");

    expect(parseBacklogTitles(md)).toEqual([
      "양방향 위키링크 [[...]] + 백링크",
      "지식 인제스트→병합 파이프라인 + Q&A 쿼리",
    ]);
  });

  it("ignores indented sub-bullets and non-checkbox lines", () => {
    const md = [
      "## 높음",
      "- [ ] **첫 항목**",
      "  - [ ] **들여쓰기된 체크박스는 무시**",
      "- 그냥 불릿은 무시",
      "- [x] **완료된 항목도 포함**",
    ].join("\n");

    expect(parseBacklogTitles(md)).toEqual(["첫 항목", "완료된 항목도 포함"]);
  });

  it("returns [] when there is no 높음 section", () => {
    const md = ["## 중간", "- [ ] **무시되는 항목**", "## 낮음", "- [ ] **이것도 무시**"].join("\n");
    expect(parseBacklogTitles(md)).toEqual([]);
  });
});
