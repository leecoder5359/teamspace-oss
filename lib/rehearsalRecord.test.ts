import { describe, it, expect } from "vitest";
import { extractRehearsalBlock, inRehearsalWindow, isQuarterlyRehearsalDay, rehearsalQuarterKey } from "./rehearsalRecord";

const OUT = [
  "✅ 1 백업 파일 3개",
  "❌ 5 docs 파일 대조 1/20 (90% 미만)",
  "",
  "결과: FAIL",
  "",
  "---- TeamSpace 문서용 ----",
  "### 백업 복원 리허설 2026-10-05",
  "",
  "- 백업: `/b/20261005`",
  "- 실행: 20261005-090000-1",
  "- ✅ 1 백업 파일 3개",
  "- ❌ 5 docs 파일 대조 1/20 (90% 미만)",
  "- 결과: **FAIL**",
  "",
].join("\n");

describe("extractRehearsalBlock", () => {
  it("문서용 블록만 꺼내고 ### 제목은 문서 제목으로 옮긴다", () => {
    const b = extractRehearsalBlock(OUT, "2000-01-01")!;
    expect(b.title).toBe("백업 복원 리허설 2026-10-05");
    expect(b.date).toBe("2026-10-05");
    expect(b.result).toBe("FAIL");
    expect(b.markdown.startsWith("- 백업: `/b/20261005`")).toBe(true);
    expect(b.markdown).not.toContain("###");
    expect(b.markdown).not.toContain("결과: FAIL\n"); // 블록 위 요약 줄은 들어가지 않는다
    expect(b.markdown.endsWith("- 결과: **FAIL**\n")).toBe(true);
  });

  it("CRLF·여러 번 실행된 로그면 마지막 블록을 쓴다", () => {
    const twice = (OUT + OUT.replace("2026-10-05", "2026-10-06").replace("**FAIL**", "**PASS**")).replace(/\n/g, "\r\n");
    const b = extractRehearsalBlock(twice, "x")!;
    expect(b.date).toBe("2026-10-06");
    expect(b.result).toBe("PASS");
  });

  it("제목 줄이 없으면 fallbackDate 로 제목을 만든다", () => {
    const b = extractRehearsalBlock("---- TeamSpace 문서용 ----\n- 결과: **PASS**\n", "2026-10-09")!;
    expect(b.title).toBe("백업 복원 리허설 2026-10-09");
    expect(b.result).toBe("PASS");
  });

  it("목록이 끝나면 멈춘다 — tee 로 받은 pnpm/셸 꼬리는 문서에 들어가지 않는다", () => {
    const b = extractRehearsalBlock(OUT + "\n ELIFECYCLE  Command failed with exit code 1.\n$ exit\n", "x")!;
    expect(b.markdown.endsWith("- 결과: **FAIL**\n")).toBe(true);
    expect(b.markdown).not.toContain("ELIFECYCLE");
    expect(b.markdown).not.toContain("$ exit");
  });

  it("블록이 없거나 비어 있으면 null", () => {
    expect(extractRehearsalBlock("결과: PASS\n", "x")).toBeNull();
    expect(extractRehearsalBlock("---- TeamSpace 문서용 ----\n### 백업 복원 리허설 2026-10-05\n\n", "x")).toBeNull();
  });
});

describe("분기 리허설 날짜", () => {
  it.each([
    ["2026-01-05", true], // 1월 첫 월요일
    ["2026-04-06", true],
    ["2026-07-06", true],
    ["2026-10-05", true],
    ["2026-10-12", false], // 둘째 월요일
    ["2026-10-06", false], // 화요일
    ["2026-02-02", false], // 분기 첫 달 아님
    ["2027-03-01", false],
  ])("%s → %s", (d, want) => {
    expect(isQuarterlyRehearsalDay(new Date(`${d}T09:00:00`))).toBe(want);
  });

  it("분기 키", () => {
    expect(rehearsalQuarterKey(new Date("2026-10-05T09:00:00"))).toBe("2026-Q4");
    expect(rehearsalQuarterKey(new Date("2026-01-05T09:00:00"))).toBe("2026-Q1");
  });
});

describe("inRehearsalWindow", () => {
  it("분기 첫 월요일 09:00~09:59 만 참", () => {
    expect(inRehearsalWindow(new Date(2026, 9, 5, 9, 0))).toBe(true);
    expect(inRehearsalWindow(new Date(2026, 9, 5, 9, 59))).toBe(true);
    expect(inRehearsalWindow(new Date(2026, 9, 5, 8, 59))).toBe(false);
    expect(inRehearsalWindow(new Date(2026, 9, 5, 10, 0))).toBe(false);
    expect(inRehearsalWindow(new Date(2026, 9, 12, 9, 0))).toBe(false);
  });
});
