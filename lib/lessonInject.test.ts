import { describe, it, expect } from "vitest";
import { renderLessons, renderLessonsReport, buildLessonSection, gistOf, capLines, neutralizeHeadings, lessonGist, normalizeStack, parseLessonStack, lessonApplicability, lessonScopeOf, lessonModeOf, parseLessonMode, type LessonLite } from "./lessonInject";
import { legacyRenderLessons, legacyLessonBudget } from "./lessonInject.legacy.fixture";

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

/* ── 레슨 주입 점검: 리팩터가 /api/context 출력을 바꾸지 않았음을 증명 ───────────── */

/** 결정적 의사난수(시드 고정) — 픽스처를 매번 같게 만든다. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
function fixture(seed: number): { lessons: LessonLite[]; projectId: string | null; projectStack: string[] } {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const words = ["배포", "마이그레이션", "훅", "세션", "예산", "Slack", "컨펌", "next", "prisma", "## 원인", "**처방**: 먼저 본다.", "실사례(로요, 2026).", "교훈 1: 작게."];
  const n = 5 + Math.floor(r() * 90);
  const lessons: LessonLite[] = Array.from({ length: n }, (_, i) => {
    const kind = r();
    const body = Array.from({ length: 3 + Math.floor(r() * 60) }, () => pick(words)).join(r() < 0.2 ? "\n" : " ");
    const title = Array.from({ length: 1 + Math.floor(r() * 8) }, () => pick(words)).join(" ");
    if (kind < 0.35) return { id: `p${seed}_${i}`, title, body, projectId: pick(["proj", "other"]), stack: null };
    if (kind < 0.55) return { id: `s${seed}_${i}`, title, body, projectId: null, stack: pick(["next", "supabase", "ios"]) };
    return { id: `g${seed}_${i}`, title, body, projectId: null, stack: null };
  });
  const projectId = r() < 0.75 ? "proj" : null;
  const projectStack = r() < 0.5 ? ["next"] : r() < 0.5 ? ["next", "supabase"] : [];
  return { lessons, projectId, projectStack };
}

describe("buildLessonSection — 리팩터 전 출력과 바이트 단위로 같다", () => {
  for (let seed = 1; seed <= 120; seed++) {
    it(`픽스처 #${seed}`, () => {
      const f = fixture(seed);
      // /api/context 가 실제로 넘기는 레슨 집합(전역 + 해당 프로젝트)과 전체 집합 둘 다 확인
      const scoped = f.projectId ? f.lessons.filter((l) => !l.projectId || l.projectId === f.projectId) : f.lessons;
      for (const lessons of [scoped, f.lessons]) {
        for (const restChars of [0, 1200, 3600, 7000, 12000]) {
          for (const compact of [true, false]) {
            const legacy = legacyRenderLessons({ lessons, projectId: f.projectId, projectName: "프로젝트", projectStack: f.projectStack, mode: compact ? "compact" : "full", budget: legacyLessonBudget(restChars) });
            const now = buildLessonSection({ lessons, projectId: f.projectId, projectName: "프로젝트", projectStack: f.projectStack, compact, restChars });
            expect(now.lines.join("\n")).toBe(legacy.join("\n"));
            expect(now.report.chars).toBe(legacy.join("\n").length);
          }
        }
      }
    });
  }
});

describe("renderLessonsReport — 레슨별 상태·섹션 예산", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => L(`g${i}`, `전역 규칙 ${i}`, "처방: " + "본문 ".repeat(60)));

  it("예산이 남으면 앞에서부터 요약(gist), 나머지는 제목만(title) — 개수가 출력과 맞는다", () => {
    const { lines, report } = renderLessonsReport({ lessons: many(20), projectId: null, projectName: null, mode: "compact", budget: 1500 });
    const md = lines.join("\n");
    const st = report.statuses.map((s) => s.status);
    const firstTitle = st.indexOf("title");
    expect(st[0]).toBe("gist");
    expect(firstTitle).toBeGreaterThan(0);
    expect(st.slice(firstTitle).every((s) => s === "title")).toBe(true);
    const sec = report.sections[0];
    expect(sec).toMatchObject({ kind: "global", count: 20, omitted: 0 });
    expect(sec.gist + sec.title).toBe(20);
    expect(sec.used).toBeLessThanOrEqual(sec.budget!);
    expect(md).toContain("- **전역 규칙 0** — ");
    expect(md).toContain(`- **전역 규칙 ${firstTitle}** \`g${firstTitle}\``);
  });

  it("제목도 다 못 담으면 뒤에서부터 '외 N개'(omitted)", () => {
    const { lines, report } = renderLessonsReport({ lessons: many(80), projectId: null, projectName: null, mode: "compact", budget: 1500 });
    const md = lines.join("\n");
    const st = report.statuses.map((s) => s.status);
    const firstOmitted = st.indexOf("omitted");
    expect(firstOmitted).toBeGreaterThan(0);
    expect(st.slice(firstOmitted).every((s) => s === "omitted")).toBe(true);
    const sec = report.sections[0];
    expect(sec.gist + sec.title + sec.omitted).toBe(80);
    expect(md).toContain(`외 ${sec.omitted}개`);
    expect(md).not.toContain(`\`g${firstOmitted}\``);
    expect(sec.used).toBeLessThanOrEqual(sec.budget!);
  });

  it("다른 프로젝트·맞지 않는 스택은 not_applicable 과 사유", () => {
    const lessons: LessonLite[] = [
      { id: "g", title: "전역", body: "처방: x", projectId: null, stack: null },
      { id: "p", title: "내 프로젝트", body: "처방: x", projectId: "proj", stack: null },
      { id: "o", title: "남의 프로젝트", body: "처방: x", projectId: "other", stack: null },
      { id: "n", title: "next", body: "처방: x", projectId: null, stack: "next" },
      { id: "i", title: "ios", body: "처방: x", projectId: null, stack: "ios" },
    ];
    const { report } = renderLessonsReport({ lessons, projectId: "proj", projectName: "P", projectStack: ["next"], mode: "compact" });
    const by = Object.fromEntries(report.statuses.map((s) => [s.id, s]));
    expect(by.g).toMatchObject({ scope: "global", status: "gist" });
    expect(by.p).toMatchObject({ scope: "project", status: "gist" });
    expect(by.n).toMatchObject({ scope: "stack", status: "gist" });
    expect(by.o).toMatchObject({ status: "not_applicable", reason: "other_project" });
    expect(by.i).toMatchObject({ status: "not_applicable", reason: "stack_mismatch" });
    expect(report.sections.map((s) => [s.kind, s.tag])).toEqual([["project", null], ["stack", "next"], ["global", null]]);
  });
});

/* ── 범위·주입 방식 개편(개인·필수·ondemand·좁은 범위 먼저) ───────────── */

describe("lessonApplicability · lessonScopeOf · parseLessonMode", () => {
  const S = { projectId: "proj", projectStack: ["next"], personId: "me" };
  it("범위별 대상 판정", () => {
    expect(lessonApplicability({ projectId: null, stack: null }, S)).toBeNull();
    expect(lessonApplicability({ projectId: "proj" }, S)).toBeNull();
    expect(lessonApplicability({ projectId: "other" }, S)).toBe("other_project");
    expect(lessonApplicability({ projectId: null, stack: "next" }, S)).toBeNull();
    expect(lessonApplicability({ projectId: null, stack: "ios" }, S)).toBe("stack_mismatch");
    expect(lessonApplicability({ projectId: null, userId: "me" }, S)).toBeNull();
    expect(lessonApplicability({ projectId: null, userId: "you" }, S)).toBe("other_person");
    expect(lessonApplicability({ projectId: null, userId: "me" }, { ...S, personId: null })).toBe("other_person");
    expect(lessonApplicability({ projectId: null, mode: "ondemand" }, S)).toBe("ondemand");
    // 범위 밖이 먼저 — 남의 개인 레슨이 ondemand 여도 사유는 other_person
    expect(lessonApplicability({ projectId: null, userId: "you", mode: "ondemand" }, S)).toBe("other_person");
  });
  it("scope 는 개인 > 프로젝트 > 스택 > 전역, 모르는 mode 는 default, 입력 mode 는 엄격", () => {
    expect(lessonScopeOf({ userId: "u", projectId: null })).toBe("personal");
    expect(lessonScopeOf({ projectId: "p" })).toBe("project");
    expect(lessonScopeOf({ projectId: null, stack: "next" })).toBe("stack");
    expect(lessonScopeOf({ projectId: null })).toBe("global");
    expect(lessonModeOf({ mode: "weird" })).toBe("default");
    expect(parseLessonMode("Required")).toEqual({ ok: true, mode: "required" });
    expect(parseLessonMode("always")).toMatchObject({ ok: false });
  });
});

describe("renderLessonsReport — 필수 먼저 · 좁은 범위 먼저 · ondemand 제외 · 개인", () => {
  const mk = (id: string, extra: Partial<LessonLite> = {}): LessonLite => ({ id, title: `규칙 ${id}`, body: "처방: " + "본문 ".repeat(60), projectId: null, stack: null, ...extra });

  it("필수 섹션이 맨 앞(범위 무관), 그다음 개인 → 프로젝트 → 스택 → 전역 순서이고 헤더에 개수", () => {
    const lessons = [
      mk("g"),
      mk("gr", { mode: "required" }),
      mk("p", { projectId: "proj" }),
      mk("pr", { projectId: "proj", mode: "required" }),
      mk("me", { userId: "me" }),
      mk("n", { stack: "next" }),
    ];
    const { lines, report } = renderLessonsReport({ lessons, projectId: "proj", projectName: "P", projectStack: ["next"], personId: "me", mode: "compact" });
    const md = lines.join("\n");
    expect(md).toContain("## 팀 작업규칙·레슨 — 반드시 따른다 (필수 2 · 개인 1 · 프로젝트 1 · 스택 1 · 전역 1)");
    const idx = ["### 필수 (2)", "### 개인 (1)", "### 프로젝트: P (1)", "### 스택: next (1)", "### 전역 (1)"].map((h) => md.indexOf(h));
    expect(idx.every((x) => x >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(report.sections.map((s) => s.kind)).toEqual(["required", "personal", "project", "stack", "global"]);
    const by = Object.fromEntries(report.statuses.map((s) => [s.id, s]));
    expect(by.gr).toMatchObject({ scope: "global", mode: "required", status: "gist" });
    expect(by.pr).toMatchObject({ scope: "project", mode: "required", status: "gist" });
    expect(by.me).toMatchObject({ scope: "personal", mode: "default", status: "gist" });
  });

  it("예산이 빠듯하면 필수는 요약까지 들어가고, 남은 예산은 좁은 범위가 먼저 요약을 가져간다(넓은 범위는 제목만)", () => {
    const lessons = [
      ...Array.from({ length: 3 }, (_, i) => mk(`r${i}`, { mode: "required" })),
      ...Array.from({ length: 6 }, (_, i) => mk(`m${i}`, { userId: "me" })),
      ...Array.from({ length: 6 }, (_, i) => mk(`g${i}`)),
    ];
    const { report } = renderLessonsReport({ lessons, projectId: null, projectName: null, personId: "me", mode: "compact", budget: 1800 });
    const by = Object.fromEntries(report.statuses.map((s) => [s.id, s.status]));
    expect([by.r0, by.r1, by.r2]).toEqual(["gist", "gist", "gist"]);
    const personalGist = Array.from({ length: 6 }, (_, i) => by[`m${i}`]).filter((s) => s === "gist").length;
    const globalGist = Array.from({ length: 6 }, (_, i) => by[`g${i}`]).filter((s) => s === "gist").length;
    expect(personalGist).toBeGreaterThan(0);
    expect(personalGist).toBeGreaterThanOrEqual(globalGist);
    // 개인 섹션이 요약을 다 받기 전에는 전역이 요약을 받지 않는다(좁은 범위 먼저)
    if (globalGist > 0) expect(personalGist).toBe(6);
    // 커버리지: 모두 제목 이상으로 보인다(잘림 없음)
    expect(Object.values(by).every((s) => s === "gist" || s === "title")).toBe(true);
  });

  it("필수가 예산을 넘으면 필수도 제목만 → '외 N개' 로 떨어지고, 다른 섹션도 개수는 드러낸다", () => {
    const lessons = [...Array.from({ length: 40 }, (_, i) => mk(`r${i}`, { mode: "required" })), ...Array.from({ length: 10 }, (_, i) => mk(`g${i}`))];
    const { lines, report } = renderLessonsReport({ lessons, projectId: null, projectName: null, mode: "compact", budget: 600 });
    const md = lines.join("\n");
    const req = report.sections.find((s) => s.kind === "required")!;
    expect(req.omitted).toBeGreaterThan(0);
    expect(req.gist + req.title + req.omitted).toBe(40);
    expect(md).toContain(`외 ${req.omitted}개`);
    expect(md).toContain("### 전역 (10)");
    const glob = report.sections.find((s) => s.kind === "global")!;
    expect(glob.gist + glob.title + glob.omitted).toBe(10);
    if (glob.omitted) expect(md).toContain(`외 ${glob.omitted}개`);
  });

  it("ondemand 는 주입하지 않고 개수만 한 줄로 알린다 — 필수·전역 어느 범위든", () => {
    const lessons = [mk("g"), mk("od", { mode: "ondemand" }), mk("odp", { projectId: "proj", mode: "ondemand" })];
    for (const mode of ["compact", "full"] as const) {
      const { lines, report } = renderLessonsReport({ lessons, projectId: "proj", projectName: "P", mode });
      const md = lines.join("\n");
      expect(md).not.toContain("`od`");
      expect(md).not.toContain("규칙 odp");
      expect(md).toContain("'필요할 때만' 레슨 2개");
      expect(md).toContain("반드시 따른다 (전역 1)");
      const by = Object.fromEntries(report.statuses.map((s) => [s.id, s]));
      expect(by.od).toMatchObject({ status: "not_applicable", reason: "ondemand", mode: "ondemand" });
    }
  });

  it("다른 사람의 개인 레슨은 빠지고(other_person), 사람을 모르면 개인 레슨은 하나도 안 들어간다", () => {
    const lessons = [mk("g"), mk("mine", { userId: "me" }), mk("yours", { userId: "you", mode: "required" })];
    const a = renderLessonsReport({ lessons, projectId: null, projectName: null, personId: "me", mode: "compact" });
    expect(a.lines.join("\n")).toContain("`mine`");
    expect(a.lines.join("\n")).not.toContain("yours");
    expect(a.report.statuses.find((s) => s.id === "yours")).toMatchObject({ status: "not_applicable", reason: "other_person" });
    const b = renderLessonsReport({ lessons, projectId: null, projectName: null, personId: null, mode: "compact" });
    expect(b.lines.join("\n")).not.toContain("### 개인");
    expect(b.report.statuses.filter((s) => s.reason === "other_person").map((s) => s.id)).toEqual(["mine", "yours"]);
  });

  it("buildLessonSection 은 personId 를 그대로 넘긴다", () => {
    const lessons = [mk("mine", { userId: "me" })];
    expect(buildLessonSection({ lessons, projectId: null, projectName: null, projectStack: [], personId: "me", compact: true, restChars: 0 }).lines.join("\n")).toContain("`mine`");
    expect(buildLessonSection({ lessons, projectId: null, projectName: null, projectStack: [], compact: true, restChars: 0 }).lines.join("\n")).not.toContain("`mine`");
  });
});
