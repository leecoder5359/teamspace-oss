import { describe, it, expect } from "vitest";
import { renderLessons, gistOf, capLines, neutralizeHeadings, lessonGist, normalizeStack, parseLessonStack } from "./lessonInject";

const L = (id: string, title: string, body: string, projectId: string | null = null) => ({ id, title, body, projectId });

describe("gistOf / neutralizeHeadings", () => {
  it("마크다운 제목·강조·줄바꿈을 걷어내고 길이를 자른다", () => {
    expect(gistOf("## 원인\n**처방**: 먼저 fetch 한다.\n\n곁가지", 20)).toBe("원인 처방: 먼저 fetch 한다.…");
    expect(gistOf("짧다", 20)).toBe("짧다");
  });
  it("본문 속 ## 제목이 컨텍스트 섹션을 깨지 않게 바꾼다", () => {
    expect(neutralizeHeadings("앞\n## 구조\n### 세부\n뒤")).toBe("앞\n▸ 구조\n▸ 세부\n뒤");
  });
});

describe("capLines", () => {
  it("예산 안에서만 담고 남은 개수를 알린다", () => {
    const r = capLines(["aaaa", "bbbb", "cccc"], 10);
    expect(r.lines).toEqual(["aaaa", "bbbb"]);
    expect(r.omitted).toBe(1);
  });
});

describe("renderLessons", () => {
  const lessons = [
    L("g1", "전역 규칙1", "실사례. 전역 처방 본문".repeat(5)),
    L("g2", "전역 규칙2", "두번째 전역"),
    L("p1", "프로젝트 규칙1", "프로젝트 처방", "proj"),
  ];

  it("프로젝트 섹션을 먼저, 전역을 다음에 나누어 그리고 개수를 헤더에 적는다", () => {
    const md = renderLessons({ lessons, projectId: "proj", projectName: "로요", mode: "full" }).join("\n");
    expect(md).toContain("## 팀 작업규칙·레슨 — 반드시 따른다 (프로젝트 1 · 전역 2)");
    expect(md.indexOf("### 프로젝트: 로요 (1)")).toBeLessThan(md.indexOf("### 전역 (2)"));
    expect(md).not.toContain("[전역]");
  });

  it("프로젝트가 없으면 전역 섹션만", () => {
    const md = renderLessons({ lessons: lessons.filter((l) => !l.projectId), projectId: null, projectName: null, mode: "full" }).join("\n");
    expect(md).not.toContain("### 프로젝트");
    expect(md).toContain("### 전역 (2)");
  });

  it("compact: 제목·요약·id 한 줄, 예산을 넘으면 제목만, 그래도 넘으면 '외 N개'", () => {
    const many = Array.from({ length: 60 }, (_, i) => L(`g${i}`, `전역 규칙 ${i} ${"아주 긴 제목 ".repeat(6)}`, "본문 ".repeat(100)));
    const md = renderLessons({ lessons: many, projectId: null, projectName: null, mode: "compact", budget: 1500 }).join("\n");
    expect(md.length).toBeLessThanOrEqual(1500 + 200);
    expect(md).toContain("`g0`");
    expect(md).toMatch(/외 \d+개/);
    expect(md).toContain("lesson_get");
  });

  it("compact: 한쪽이 다른 쪽 예산을 다 먹지 않는다(전역도 반드시 일부 들어간다)", () => {
    const proj = Array.from({ length: 40 }, (_, i) => L(`p${i}`, `프로젝트 규칙 ${i}`, "본문 ".repeat(100), "proj"));
    const glob = Array.from({ length: 40 }, (_, i) => L(`g${i}`, `전역 규칙 ${i}`, "본문 ".repeat(100)));
    const md = renderLessons({ lessons: [...proj, ...glob], projectId: "proj", projectName: "로요", mode: "compact", budget: 2000 }).join("\n");
    expect(md).toContain("`p0`");
    expect(md).toContain("`g0`");
  });
});

describe("lessonGist", () => {
  it("처방이 있으면 처방부터 보여준다", () => {
    expect(lessonGist("실사례(로요, 2026). 무슨 일이 있었다.\n\n**처방 1: origin 기준으로 본다.** 이유…", 30)).toBe("origin 기준으로 본다. 이유…");
  });
  it("교훈이 있으면 교훈", () => {
    expect(lessonGist("실사례(x). 길게 설명.\n**교훈 1: 스키마 단위로 판단한다.**", 40)).toBe("스키마 단위로 판단한다.");
  });
  it("둘 다 없으면 앞머리의 '실사례(...).' 문장을 건너뛴다", () => {
    expect(lessonGist("실사례(로요, 2026-08-21). 체크박스를 조건부로 숨겼다.", 40)).toBe("체크박스를 조건부로 숨겼다.");
    expect(lessonGist("그냥 규칙 본문", 40)).toBe("그냥 규칙 본문");
  });
});

describe("renderLessons — 스택 레슨", () => {
  const S = (id: string, title: string, stack: string) => ({ id, title, body: "처방: 스택 규칙", projectId: null, stack });
  const lessons = [
    { ...L("g1", "전역 규칙", "처방: 공통"), stack: null },
    S("n1", "Next 규칙", "next"),
    S("s1", "Supabase 규칙", "supabase"),
    { ...L("p1", "프로젝트 규칙", "처방: 로요", "proj"), stack: null },
  ];

  it("프로젝트 스택에 맞는 스택 섹션만 넣고, 프로젝트 → 스택 → 전역 순서", () => {
    const md = renderLessons({ lessons, projectId: "proj", projectName: "TeamSpace", projectStack: ["next"], mode: "full" }).join("\n");
    expect(md).toContain("## 팀 작업규칙·레슨 — 반드시 따른다 (프로젝트 1 · 스택 1 · 전역 1)");
    expect(md).toContain("### 스택: next (1)");
    expect(md).not.toContain("Supabase 규칙");
    const [a, b, c] = ["### 프로젝트: TeamSpace", "### 스택: next", "### 전역"].map((h) => md.indexOf(h));
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
  });

  it("스택 레슨은 전역 섹션에 섞이지 않는다", () => {
    const md = renderLessons({ lessons, projectId: "proj", projectName: "X", projectStack: [], mode: "full" }).join("\n");
    expect(md).toContain("### 전역 (1)");
    expect(md).not.toContain("Next 규칙");
  });

  it("프로젝트가 매핑되지 않으면 스택 레슨은 빼되 몇 개 뺐는지 적는다", () => {
    const md = renderLessons({ lessons, projectId: null, projectName: null, projectStack: [], mode: "compact" }).join("\n");
    expect(md).not.toContain("Next 규칙");
    expect(md).toContain("스택 레슨 2개");
  });
});

describe("normalizeStack", () => {
  it("소문자·중복 제거·허용 문자만", () => {
    expect(normalizeStack("Next, supabase ,next")).toEqual({ ok: true, stack: ["next", "supabase"] });
    expect(normalizeStack(["React Native"])).toMatchObject({ ok: false });
    expect(normalizeStack("")).toEqual({ ok: true, stack: [] });
  });
});

describe("parseLessonStack", () => {
  it("태그 하나만, 빈 값·null 은 해제", () => {
    expect(parseLessonStack("Next")).toEqual({ ok: true, stack: "next" });
    expect(parseLessonStack(null)).toEqual({ ok: true, stack: null });
    expect(parseLessonStack("")).toEqual({ ok: true, stack: null });
    expect(parseLessonStack("next,supabase")).toMatchObject({ ok: false });
  });
});
