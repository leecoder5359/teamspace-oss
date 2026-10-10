import { describe, expect, it } from "vitest";
import { defaultPrefix, hasReviewTask, planReviewImport, parseReviewTables, reviewTaskBody, reviewTaskTitle, stripEmphasis } from "./reviewImport";

// 2026-10-08 전체 리뷰 doc 발췌
const DOC = `# TeamSpace main 전체 리뷰 (2026-10-08)

## 0. 한 장 요약

| 구분 | 내용 |
|---|---|
| 기능 | 결함 5건 |

## 1. 결함 (브라우저 + 코드로 확인)

| # | 심각도 | 발견 | 근거 | 제안 |
|---|---|---|---|---|
| B1 | 높음 | 존재하지 않는 \`/p/<id>\` 가 **admin 에게 빈 BlockNote 에디터**("제목 없음")로 열린다. 콘솔 오류. | \`app/(ws)/p/[id]/page.tsx\`: \`pageAccess()\` 가 admin 은 무조건 \`edit\`. | \`page\` 가 null 이면 \`notFound()\`. |
| B2 | 중간 | 마크다운 표에서 **인라인 코드 안의 \`\\|\`** 가 셀 구분자로 처리돼 행이 깨진다. | \`lib/md/parse.ts\` \`splitCells()\` 단순 split. | 코드 스팬 밖의 \`\\|\` 만 분리. |
| B5 | 낮음 | 같은 제목 문서 2쌍. | \`/docs\` 목록. | 409 opt-in. |

## 2. UI/UX

| # | 영역 | 발견 | 제안 |
|---|---|---|---|
| U1 | 레이아웃 | **사이드바가 본문과 함께 스크롤**. 높이 제한이 없다. | 데스크톱 sticky. |

## 3. 위험 — 프로덕션 준비

| # | 항목 | 현재 | 제안 |
|---|---|---|---|
| P1 | 오류 화면 | \`app/error.tsx\` 없음. | 세 파일. |

## 6. 코드 리뷰

| # | 파일 | 발견 | 조치 |
|---|---|---|---|
| C2 | \`scripts/ws.ts:1727\` | exclude 무한 누적. | 서버가 영속. |

## 7. 추가하면 좋은 기능

| # | 제안 | 왜 | 크기 |
|---|---|---|---|
| F1 | 알림 그룹핑 | 미읽음 100 | S |

## 8. AI 비용

| # | 낭비 지점 | 측정 | 비고 |
|---|---|---|---|
| A-1 | SessionStart 컨텍스트 주입 | 5~8K 토큰/회 | 훅 matcher |
| 합계 | 무시 | x | y |
`;

describe("parseReviewTables", () => {
  const rows = parseReviewTables(DOC);

  it("코드 행만 뽑고 코드 아닌 행·표는 무시한다", () => {
    expect(rows.map((r) => r.code)).toEqual(["B1", "B2", "B5", "U1", "P1", "C2", "F1", "A-1"]);
  });

  it("§1 표: 심각도·발견·근거·제안 + 섹션", () => {
    const b1 = rows[0];
    expect(b1.section).toBe("1. 결함 (브라우저 + 코드로 확인)");
    expect(b1.severity).toBe("높음");
    expect(b1.finding).toContain("admin 에게 빈 BlockNote 에디터");
    expect(b1.finding).not.toContain("**");
    expect(b1.evidence).toContain("pageAccess()");
    expect(b1.proposal).toBe("page 가 null 이면 notFound().");
  });

  it("코드 스팬 안의 \\| 는 셀을 쪼개지 않는다", () => {
    const b2 = rows[1];
    expect(b2.finding).toContain("인라인 코드 안의 |");
    expect(b2.proposal).toContain("밖의 | 만 분리");
  });

  it("열 구성이 다른 표: 영역/항목은 근거로, 파일은 근거, 조치는 제안", () => {
    expect(rows[3]).toMatchObject({ code: "U1", severity: null, evidence: "레이아웃", proposal: "데스크톱 sticky." });
    expect(rows[4]).toMatchObject({ code: "P1", evidence: "오류 화면", finding: "app/error.tsx 없음." });
    expect(rows[5]).toMatchObject({ code: "C2", evidence: "scripts/ws.ts:1727", proposal: "서버가 영속." });
  });

  it("발견 열이 없는 제안 표는 제안 열이 본문", () => {
    expect(rows[6]).toMatchObject({ code: "F1", finding: "알림 그룹핑", proposal: null, evidence: "미읽음 100" });
  });

  it("A-5 형 코드와 낭비 지점/측정 열", () => {
    expect(rows[7]).toMatchObject({ code: "A-1", finding: "SessionStart 컨텍스트 주입", evidence: "5~8K 토큰/회" });
  });
});

describe("reviewTaskTitle", () => {
  const base = { code: "B1", section: "1", severity: null, evidence: null, proposal: null };
  it("접두어·코드·첫 문장, 강조 제거", () => {
    const r = { ...base, finding: "**없는 페이지**가 빈 에디터로 열린다. 콘솔 오류." };
    expect(reviewTaskTitle("[리뷰 10/08]", r)).toBe("[리뷰 10/08] B1 없는 페이지가 빈 에디터로 열린다.");
  });
  it("snake_case·단어 안 밑줄은 남긴다", () => {
    const r = { ...base, finding: "load_board_data 가 **빈 값**을 돌려준다. 나머지." };
    expect(reviewTaskTitle("[리뷰]", r)).toBe("[리뷰] B1 load_board_data 가 빈 값을 돌려준다.");
  });
  it("90자 초과는 … 로 자른다", () => {
    const t = reviewTaskTitle("[리뷰 10/08]", { ...base, finding: "가".repeat(200) });
    expect(t.length).toBe(90);
    expect(t.endsWith("…")).toBe(true);
  });
});

describe("stripEmphasis", () => {
  it("강조 토큰만 벗긴다", () => {
    expect(stripEmphasis("**굵게** *기울* _기울_ __굵게__ ~~취소~~ ==형광==")).toBe("굵게 기울 기울 굵게 취소 형광");
  });
  it("단어 안 밑줄·짝 없는 기호는 그대로", () => {
    expect(stripEmphasis("my_var_name 과 a * b 와 x == y")).toBe("my_var_name 과 a * b 와 x == y");
  });
});

describe("reviewTaskBody", () => {
  it("심각도·발견·근거·제안·출처", () => {
    const body = reviewTaskBody("doc1", { code: "B1", section: "1. 결함", severity: "높음", finding: "f", evidence: "e", proposal: "p" });
    expect(body).toBe("심각도: 높음\n발견: f\n근거: e\n제안: p\n출처: /p/doc1 §1. 결함");
  });
  it("없는 항목은 줄째 생략", () => {
    const body = reviewTaskBody("d", { code: "A-1", section: "8", severity: null, finding: "f", evidence: null, proposal: null });
    expect(body).toBe("발견: f\n출처: /p/d §8");
  });
});

describe("defaultPrefix · hasReviewTask", () => {
  it("제목의 날짜 → [리뷰 MM/DD]", () => {
    expect(defaultPrefix("TeamSpace main 전체 리뷰 (2026-10-08)", new Date(2026, 9, 9))).toBe("[리뷰 10/08]");
  });
  it("날짜 없으면 오늘", () => {
    expect(defaultPrefix("리뷰", new Date(2026, 0, 5))).toBe("[리뷰 01/05]");
  });
  it("코드 경계로 중복 판정(B1 ≠ B10)", () => {
    const titles = ["[리뷰 10/08] B10 다른 것", "[리뷰 10/08] B2 있음"];
    expect(hasReviewTask(titles, "[리뷰 10/08]", "B1")).toBe(false);
    expect(hasReviewTask(titles, "[리뷰 10/08]", "B2")).toBe(true);
  });
});

describe("planReviewImport (api 스텁 없이 순수 계획)", () => {
  const mk = (code: string) => ({ code, section: "1", severity: null, finding: `${code} 문제.`, evidence: null, proposal: null });
  it("기존 제목은 건너뛰고 나머지만 만든다", () => {
    const plan = planReviewImport([mk("B1"), mk("B2"), mk("B1")], ["[리뷰 10/08] B1 문제."], "[리뷰 10/08]");
    expect(plan.create.map((c) => c.title)).toEqual(["[리뷰 10/08] B2 B2 문제."]);
    expect(plan.skipped.map((r) => r.code)).toEqual(["B1", "B1"]);
  });
  it("재실행하면 전부 건너뜀(멱등)", () => {
    const first = planReviewImport([mk("B1"), mk("B2")], [], "[리뷰 10/08]");
    const again = planReviewImport([mk("B1"), mk("B2")], first.create.map((c) => c.title), "[리뷰 10/08]");
    expect(again.create).toEqual([]);
    expect(again.skipped).toHaveLength(2);
  });
});
