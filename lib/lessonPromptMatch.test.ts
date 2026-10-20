import { describe, it, expect } from "vitest";
import { matchPromptLessons, mentionedProjects, keywordScore, KEYWORD_MIN_SCORE, LESSON_ROLES, normalizeTerms, termIn, PROMPT_BUDGET, type PromptLesson, type PromptProject } from "./lessonPromptMatch";

const projects: PromptProject[] = [
  { id: "bj", name: "반장 — 인테리어 창업 MVP", aliases: ["반장", "banjang"], stack: ["next", "supabase"] },
  { id: "ly", name: "로요", aliases: ["loyo"], stack: ["next"] },
  { id: "ts", name: "TeamSpace 개발", aliases: ["teamspace", "팀스페이스"], stack: ["next", "prisma"] },
];
let n = 0;
const les = (o: Partial<PromptLesson> & { id: string }): PromptLesson => ({
  title: `레슨 ${o.id}`,
  body: `처방: ${o.id} 는 이렇게 한다.`,
  projectId: null,
  stack: null,
  userId: null,
  mode: "ondemand",
  keywords: [],
  updatedAt: new Date(Date.UTC(2026, 9, 1, 0, n++)),
  ...o,
});

describe("termIn — 단어 매칭", () => {
  it("ASCII 는 더 긴 ASCII 단어 안에서 맞지 않는다, 한글 조사·구두점 옆은 맞는다", () => {
    expect(termIn("employoo 수정", "loyo")).toBe(false);
    expect(termIn("build 고치기", "ui")).toBe(false);
    expect(termIn("loyo에서 결제", "loyo")).toBe(true);
    expect(termIn("(loyo) 결제", "loyo")).toBe(true);
    expect(termIn("deploy loyo", "loyo")).toBe(true);
    expect(termIn("next.js 16", "next.js")).toBe(true);
  });
  it("role:* 태그는 ASCII 단어로 앞뒤 경계까지 맞춘다(SubagentStart 훅의 role 레슨)", () => {
    expect(termIn("role:implementer", "role:implementer")).toBe(true);
    expect(termIn("role:implementers", "role:implementer")).toBe(false);
    expect(termIn("xrole:implementer", "role:implementer")).toBe(false);
    expect(termIn("role:reviewer", "role:implementer")).toBe(false);
  });
  it("비ASCII 는 부분 문자열", () => {
    expect(termIn("반장에서 도면", "반장")).toBe(true);
    expect(termIn("반 장", "반장")).toBe(false);
  });
});

describe("normalizeTerms", () => {
  it("쉼표 문자열·배열 → 소문자·중복 제거", () => {
    expect(normalizeTerms("Prisma, migrate ,prisma")).toEqual({ ok: true, terms: ["prisma", "migrate"] });
    expect(normalizeTerms(["  반장 ", "BANJANG"])).toEqual({ ok: true, terms: ["반장", "banjang"] });
    expect(normalizeTerms(null)).toEqual({ ok: true, terms: [] });
    expect(normalizeTerms("")).toEqual({ ok: true, terms: [] });
  });
  it("1자·너무 긴 값·너무 많은 개수는 거절", () => {
    expect(normalizeTerms("a,bb").ok).toBe(false);
    expect(normalizeTerms("x".repeat(41)).ok).toBe(false);
    expect(normalizeTerms(Array.from({ length: 31 }, (_, i) => `k${i}`)).ok).toBe(false);
  });
});

describe("mentionedProjects", () => {
  it("별칭·이름(대소문자 무시)으로 찾는다", () => {
    expect(mentionedProjects("반장 도면 가져오기 고치자", projects)).toEqual(["bj"]);
    expect(mentionedProjects("Loyo 결제 확인하고 TeamSpace 개발 보드 정리", projects)).toEqual(["ly", "ts"]);
    expect(mentionedProjects("employoo 리팩터", projects)).toEqual([]);
  });
});

describe("matchPromptLessons", () => {
  const lessons: PromptLesson[] = [
    les({ id: "g-prisma", keywords: ["prisma", "schema", "마이그레이션"] }),
    les({ id: "g-deploy", keywords: ["배포"] , mode: "default" }),
    les({ id: "g-req", keywords: ["prisma"], mode: "required" }),
    les({ id: "bj1", projectId: "bj", keywords: ["도면"] }),
    les({ id: "bj2", projectId: "bj" }),
    les({ id: "bj3", projectId: "bj" }),
    les({ id: "ly1", projectId: "ly", keywords: ["결제"] }),
    les({ id: "st-supa", stack: "supabase", keywords: ["rls", "정책"] }),
    les({ id: "me1", userId: "me", keywords: ["prisma", "schema"] }),
    les({ id: "you1", userId: "you", keywords: ["prisma", "schema"] }),
  ];
  const run = (prompt: string, o: Partial<Parameters<typeof matchPromptLessons>[0]> = {}) =>
    matchPromptLessons({ prompt, lessons, projects, cwdProjectId: "ts", personId: "me", ...o });

  it("짧은 메시지는 아무것도 안 한다", () => {
    expect(run("배포 하자")).toMatchObject({ markdown: "", lessonIds: [] });
    expect(run("  ㅇ ㅇ  ")).toMatchObject({ markdown: "", lessonIds: [] });
  });

  it("키워드가 맞은 레슨 — required 는 빼고(세션 시작에 이미), 다른 사람 개인 레슨도 뺀다", () => {
    const r = run("prisma schema 마이그레이션 하나 추가하자");
    expect(r.lessonIds).toEqual(["g-prisma", "me1"]); // 점수 높은 g-prisma 가 먼저
    expect(r.markdown).toContain("`g-prisma`");
    expect(r.markdown).not.toContain("g-req");
    expect(r.markdown).not.toContain("you1");
  });

  it("다른 프로젝트 레슨은 언급이 없으면 범위 밖, 언급하면 열린다(키워드 맞은 것만 — 기본 포함 안 함)", () => {
    expect(run("도면 가져오기 손보자").lessonIds).toEqual([]);
    const r = run("반장 도면 가져오기 손보자");
    expect(r.mentionedProjectIds).toEqual(["bj"]);
    expect(r.lessonIds).toEqual(["bj1"]);
    expect(r.markdown).toContain("_언급된 프로젝트: 반장 — 인테리어 창업 MVP_");
  });

  it("언급된 프로젝트에 키워드 맞은 레슨이 없으면 그 프로젝트 레슨 최근 N개", () => {
    const r = run("banjang 쪽 작업 이어서 하자", { baseN: 2 });
    expect(r.lessonIds).toEqual(["bj3", "bj2"]);
  });

  it("스택 레슨은 cwd·언급 프로젝트의 스택이 맞을 때만", () => {
    expect(run("rls 정책 점검하자").lessonIds).toEqual([]); // teamspace 스택엔 supabase 없음
    expect(run("반장 rls 정책 점검하자").lessonIds).toContain("st-supa");
  });

  it("exclude(이 세션에 이미 넣은 것)는 다시 넣지 않는다", () => {
    expect(run("prisma schema 마이그레이션 하나 추가하자", { exclude: ["g-prisma"] }).lessonIds).toEqual(["me1"]);
  });

  it("예산 안에서 자르고 넘친 개수를 적는다", () => {
    const many = Array.from({ length: 80 }, (_, i) => les({ id: `k${i}`, keywords: ["배포", "카나리", "롤백"], body: "처방: " + "아주 긴 본문 ".repeat(40) }));
    const r = matchPromptLessons({ prompt: "배포 카나리 롤백 준비 해 보자", lessons: many, projects, cwdProjectId: null, personId: null });
    expect(r.markdown.length).toBeLessThanOrEqual(PROMPT_BUDGET);
    expect(r.lessonIds.length).toBeGreaterThan(3);
    expect(r.lessonIds.length).toBeLessThan(80);
    expect(r.markdown).toContain(`- … 외 ${80 - r.lessonIds.length}개`);
    for (const id of r.lessonIds) expect(r.markdown).toContain(`\`${id}\``);
  });

  describe("키워드 점수 문턱(구체어 1 · 일반어 0.5 · 2 이상) · 에이전트 알림", () => {
    const gate: PromptLesson[] = [
      les({ id: "g-two", keywords: ["prisma", "schema"] }),
      les({ id: "g-gen", keywords: ["배포", "카나리"] }),
      les({ id: "g-gen2", keywords: ["배포", "테스트"] }),
      les({ id: "bj-gen", projectId: "bj", keywords: ["배포"] }),
    ];
    const g = (prompt: string) => matchPromptLessons({ prompt, lessons: gate, projects, cwdProjectId: "ts", personId: "me" });

    it("다른 세션·서브에이전트·시스템 알림 메시지는 빈 결과", () => {
      for (const tag of ["cross-session-message", "teammate-message", "task-notification", "system-reminder"]) {
        const r = g(`<${tag} from="x">반장 prisma schema 배포 카나리 정리했어</${tag}>`);
        expect(r).toMatchObject({ markdown: "", lessonIds: [], mentionedProjectIds: [] });
      }
    });

    it("role:* 태그는 하나만 맞아도 들어간다 — SubagentStart 훅이 prompt \"role:<agent>\" 로 부른다", () => {
      const roles = [les({ id: "r-impl", keywords: ["role:implementer"] }), les({ id: "r-rev", keywords: ["role:reviewer"] })];
      const r = matchPromptLessons({ prompt: "role:implementer", lessons: roles, projects, cwdProjectId: "ts", personId: "me" });
      expect(r.lessonIds).toEqual(["r-impl"]);
    });

    it("role: 가산점은 역할 3개만 — role:x 하나로는 문턱을 못 넘고 role:reviewer 하나는 넘는다", () => {
      const roles = [les({ id: "r-x", keywords: ["role:x"] }), les({ id: "r-rev", keywords: ["role:reviewer"] })];
      const m = (prompt: string) => matchPromptLessons({ prompt: `${prompt} 작업 시작`, lessons: roles, projects, cwdProjectId: "ts", personId: "me" }).lessonIds;
      expect(m("role:x")).toEqual([]);
      expect(m("role:reviewer")).toEqual(["r-rev"]);
      expect(keywordScore(["role:x"])).toBe(1);
      expect(keywordScore(["role:reviewer"])).toBe(KEYWORD_MIN_SCORE);
      expect(LESSON_ROLES).toEqual(["implementer", "reviewer", "researcher"]);
    });

    it("전역 레슨 — 구체어 하나만 맞으면(점수 1) 빠진다", () => {
      expect(g("prisma 쪽 손보자 오늘").lessonIds).toEqual([]);
    });

    it("전역 레슨 — 구체어 둘(점수 2)이면 들어간다", () => {
      expect(g("prisma schema 손보자 오늘").lessonIds).toEqual(["g-two"]);
    });

    it("일반어 하나(배포, 점수 0.5)만으로는 빠진다", () => {
      expect(g("배포 준비 해 보자").lessonIds).toEqual([]);
    });

    it("일반어 둘(배포+테스트, 점수 1)도 빠진다", () => {
      expect(g("배포 테스트 준비 해 보자").lessonIds).toEqual([]);
    });

    it("프로젝트 레슨은 그 프로젝트가 언급되면 한 개만 맞아도(일반어라도) 들어간다", () => {
      const r = g("반장 배포 준비 해 보자");
      expect(r.mentionedProjectIds).toEqual(["bj"]);
      expect(r.lessonIds).toEqual(["bj-gen"]);
    });
  });

  it("아무것도 안 맞으면 빈 markdown", () => {
    expect(run("오늘 날씨가 좋네요 그렇죠")).toMatchObject({ markdown: "", lessonIds: [], mentionedProjectIds: [] });
  });
});
