/* =====================================================================
   프롬프트 기반 레슨 매칭(순수) — UserPromptSubmit 훅(scripts/hooks/teamspace-prompt-lessons.mjs)이
   POST /api/context/prompt 로 부르는 판정.

   세션 시작은 '필수' 레슨만 싣고, 나머지(default·ondemand)는 사용자가 **무슨 일을 하겠다고 말할 때**
   그 메시지에 맞는 것만 넣는다:
   ① 언급된 프로젝트 — 이름·별칭(Project.aliases)이 메시지에 있으면 그 프로젝트(와 스택) 범위가 열린다.
   ② 키워드 — Lesson.keywords 가 메시지에 있으면 점수(맞은 키워드 수). 키워드 맞은 레슨이 먼저.
   ③ 기본 포함 — 언급된 프로젝트에 키워드 맞은 레슨이 하나도 없으면 그 프로젝트 레슨 최근 N개.
   대상 범위 = cwd 프로젝트 ∪ 언급된 프로젝트 ∪ 그 스택 ∪ 전역 ∪ 내 개인. 필수(required)는 세션 시작에
   이미 들어가 있으므로 뺀다. 예산(문자) 안에서 요약 줄(lessonGist)로 그린다.
   프롬프트 원문은 여기서 판정에만 쓰고 어디에도 남기지 않는다(라우트도 기록하지 않는다).
   ===================================================================== */

import { capLines, lessonApplicability, lessonGist, lessonModeOf, lessonScopeOf } from "@/lib/lessonInject";

/** 프롬프트 주입 예산(문자) — 매 메시지마다 붙으므로 세션 시작(9KB)보다 훨씬 작게. */
export const PROMPT_BUDGET = 3000;
/** 이보다 짧은 메시지(공백 제외)는 판정하지 않는다("ㅇㅇ", "계속" 등). */
export const PROMPT_MIN_CHARS = 6;
/** 언급된 프로젝트에 키워드 맞은 레슨이 없을 때 기본으로 넣는 그 프로젝트 레슨 수(최근 순). */
export const MENTION_BASE_N = 5;
/** 판정에 쓰는 프롬프트 최대 길이 — 붙여 넣은 긴 로그 전체를 훑지 않는다. */
const SCAN_MAX = 20_000;

export type PromptLesson = {
  id: string;
  title: string;
  body: string;
  projectId: string | null;
  stack?: string | null;
  userId?: string | null;
  mode?: string | null;
  keywords?: string[] | null;
  updatedAt?: Date | string | null;
};

export type PromptProject = { id: string; name: string; aliases?: string[] | null; stack?: string[] | null };

/* ── 키워드·별칭 정규화 ───────────────────────────────────────────── */

const TERM_MAX = 40;
const TERMS_MAX = 30;

/** "a, B ,a" | ["a","b"] → ["a","b"] (소문자·공백 정리·중복 제거). 2자 미만·40자 초과·개수 초과는 거절. */
export function normalizeTerms(raw: unknown, what = "키워드"): { ok: true; terms: string[] } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, terms: [] };
  const parts = (Array.isArray(raw) ? raw : String(raw).split(","))
    .map((x) => String(x).replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);
  const bad = parts.filter((x) => [...x].length < 2 || x.length > TERM_MAX);
  if (bad.length) return { ok: false, error: `${what}는 2~${TERM_MAX}자입니다: ${bad.join(", ")}` };
  const terms = [...new Set(parts)];
  if (terms.length > TERMS_MAX) return { ok: false, error: `${what}는 ${TERMS_MAX}개까지입니다.` };
  return { ok: true, terms };
}

/* ── 단어 매칭 ───────────────────────────────────────────────────── */

const ASCII_WORD = /[a-z0-9_]/;
const ASCII_ONLY = /^[\x00-\x7f]+$/;

/** text(소문자)에 term(소문자)이 있는가. ASCII 단어는 더 긴 ASCII 단어 안에서는 맞지 않는다
    ("loyo" ≠ "employoo", "ui" ≠ "build") — 앞뒤가 영숫자가 아니면 맞음(한글 조사 "banjang에서" 는 맞음).
    한글 등 비ASCII 가 섞인 단어는 부분 문자열로 맞춘다("반장" ⊂ "반장에서"). */
export function termIn(text: string, term: string): boolean {
  if (!term) return false;
  if (!ASCII_ONLY.test(term)) return text.includes(term);
  let from = 0;
  for (;;) {
    const i = text.indexOf(term, from);
    if (i < 0) return false;
    const before = i > 0 ? text[i - 1] : "";
    const after = text[i + term.length] ?? "";
    const edgeOk = (c: string, termEdge: string) => !c || !ASCII_WORD.test(termEdge) || !ASCII_WORD.test(c);
    if (edgeOk(before, term[0]) && edgeOk(after, term[term.length - 1])) return true;
    from = i + 1;
  }
}

/** 사용자가 쓴 작업 요청이 아니라 다른 세션·서브에이전트·시스템이 끼워 넣은 알림이면 주입하지 않는다
    (다른 세션 메시지의 "푸시·마이그레이션·배포" 같은 일반어로 무관한 레슨이 우르르 들어오던 문제). */
const AGENT_NOTICE = /<(cross-session-message|teammate-message|task-notification|system-reminder)\b/i;
export function isAgentNotice(prompt: string): boolean {
  return AGENT_NOTICE.test(String(prompt ?? "").slice(0, 2000));
}

/** 거의 모든 작업 메시지에 나오는 일반어 — 이것만으로는 레슨을 넣지 않는다(점수 0.5). */
export const GENERIC_TERMS = new Set([
  "푸시", "push", "배포", "deploy", "마이그레이션", "migration", "migrate", "테스트", "test", "커밋", "commit",
  "prod", "운영", "dev", "db", "api", "ui", "에러", "오류", "error", "빌드", "build", "브랜치", "branch",
  "버그", "bug", "수정", "fix", "로그", "log", "env", "설정", "화면",
]);
export const KEYWORD_MIN_SCORE = 2;
/** 역할 에이전트 — role:<이것> 태그만 하나로 문턱을 넘는다. SubagentStart 훅의 ROLE_AGENTS 가 사본이다
    (전역 사본으로도 돌아 lib 를 import 못 함 — 두 목록이 같은지는 그 훅 테스트가 묶는다). */
export const LESSON_ROLES = ["implementer", "reviewer", "researcher"];
const ROLE_TAGS = new Set(LESSON_ROLES.map((r) => `role:${r}`));
/** 키워드 점수: 구체어 1 · 일반어 0.5 · 역할 태그(role:implementer 등 LESSON_ROLES 만) 문턱 그대로. 레슨은 점수 2 이상이거나, 그 레슨의 프로젝트가 메시지에 언급됐을 때만 들어간다.
    역할 태그는 SubagentStart 훅(scripts/hooks/teamspace-subagent-start.mjs)이 prompt "role:<agent>" 로 부르는 명시 태그라 하나로 충분하다.
    그 밖의 role:x 는 일반 구체어(1)다 — 아무 레슨이나 role: 키워드로 문턱을 우회하지 못하게. */
export function keywordScore(hits: string[]): number {
  return hits.reduce((n, h) => n + (ROLE_TAGS.has(h) ? KEYWORD_MIN_SCORE : GENERIC_TERMS.has(h) ? 0.5 : 1), 0);
}

export function normalizePrompt(prompt: string): string {
  return String(prompt ?? "").slice(0, SCAN_MAX).toLowerCase();
}

/** 메시지에 언급된 프로젝트 — 이름 전체 또는 별칭(2자 이상). */
export function mentionedProjects(prompt: string, projects: PromptProject[]): string[] {
  const text = normalizePrompt(prompt);
  const out: string[] = [];
  for (const p of projects) {
    const terms = [p.name, ...(p.aliases ?? [])].map((t) => String(t ?? "").trim().toLowerCase()).filter((t) => [...t].length >= 2);
    if (terms.some((t) => termIn(text, t))) out.push(p.id);
  }
  return out;
}

/* ── 매칭 ────────────────────────────────────────────────────────── */

export type PromptMatchEntry = {
  lesson: PromptLesson;
  /** 맞은 키워드(소문자) */
  hits: string[];
  /** keyword: 키워드로 · mention: 언급된 프로젝트의 기본 포함 */
  reason: "keyword" | "mention";
};

export type PromptMatchResult = {
  mentionedProjectIds: string[];
  /** 순위 순(키워드 맞은 것 먼저, 점수 높은 순 → 최근 순, 그다음 기본 포함) — 예산 적용 전 */
  ranked: PromptMatchEntry[];
  /** 예산 안에서 그린 마크다운(대상 없으면 "") */
  markdown: string;
  /** markdown 에 실제로 들어간 레슨 id(순서대로) */
  lessonIds: string[];
};

const ts = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() || 0 : 0);

export function matchPromptLessons(i: {
  prompt: string;
  lessons: PromptLesson[];
  projects: PromptProject[];
  cwdProjectId?: string | null;
  personId?: string | null;
  /** 이 세션에 이미 넣은 레슨(훅 상태 파일) — 다시 넣지 않는다 */
  exclude?: string[];
  budget?: number;
  baseN?: number;
}): PromptMatchResult {
  const empty = (mentionedProjectIds: string[] = []): PromptMatchResult => ({ mentionedProjectIds, ranked: [], markdown: "", lessonIds: [] });
  const raw = String(i.prompt ?? "");
  if (raw.replace(/\s+/g, "").length < PROMPT_MIN_CHARS) return empty();
  if (isAgentNotice(raw)) return empty();
  const text = normalizePrompt(raw);
  const byId = new Map(i.projects.map((p) => [p.id, p]));
  const mentioned = mentionedProjects(raw, i.projects);

  // 대상 범위: cwd 프로젝트 + 언급된 프로젝트 각각(그 스택 포함) — 하나라도 맞으면 대상.
  const scopeIds = [...new Set([i.cwdProjectId ?? null, ...mentioned])];
  const ctxs = scopeIds.map((pid) => ({ projectId: pid, projectStack: pid ? (byId.get(pid)?.stack ?? []) : [], personId: i.personId ?? null }));
  if (!ctxs.length) ctxs.push({ projectId: null, projectStack: [], personId: i.personId ?? null });
  const exclude = new Set(i.exclude ?? []);
  const eligible = i.lessons.filter((l) => {
    if (exclude.has(l.id) || lessonModeOf(l) === "required") return false;
    // ondemand 도 여기선 대상 — 범위 판정만 본다(lessonApplicability 의 ondemand 사유는 세션 시작용).
    const asDefault = { ...l, mode: "default" };
    return ctxs.some((c) => lessonApplicability(asDefault, c) === null);
  });

  const keyword: PromptMatchEntry[] = [];
  for (const l of eligible) {
    const hits = [...new Set((l.keywords ?? []).map((k) => k.toLowerCase()))].filter((k) => termIn(text, k));
    if (!hits.length) continue;
    const score = keywordScore(hits);
    const ownProjectMentioned = !!l.projectId && mentioned.includes(l.projectId);
    if (score >= KEYWORD_MIN_SCORE || ownProjectMentioned) keyword.push({ lesson: l, hits, reason: "keyword" });
  }
  keyword.sort((a, b) => keywordScore(b.hits) - keywordScore(a.hits) || ts(b.lesson.updatedAt) - ts(a.lesson.updatedAt));

  const hitIds = new Set(keyword.map((e) => e.lesson.id));
  const base: PromptMatchEntry[] = [];
  for (const pid of mentioned) {
    const own = eligible.filter((l) => lessonScopeOf(l) === "project" && l.projectId === pid);
    if (own.some((l) => hitIds.has(l.id))) continue;
    own
      .sort((a, b) => ts(b.updatedAt) - ts(a.updatedAt))
      .slice(0, i.baseN ?? MENTION_BASE_N)
      .forEach((l) => base.push({ lesson: l, hits: [], reason: "mention" }));
  }
  const ranked = [...keyword, ...base];
  if (!ranked.length) return empty(mentioned);

  const budget = i.budget ?? PROMPT_BUDGET;
  const names = mentioned.map((id) => byId.get(id)?.name).filter(Boolean);
  const head = [
    "## 이 메시지와 관련된 팀 레슨 (TeamSpace) — 작업에 적용한다",
    ...(names.length ? [`_언급된 프로젝트: ${names.join(" · ")}_`] : []),
  ];
  const foot = "_전문: MCP `lesson_get {id}` (TeamSpace 레포에서는 `pnpm ws lesson show <id>`)._";
  const more = (n: number) => `- … 외 ${n}개 (MCP \`lesson_list\` q=제목 검색)`;
  const line = (e: PromptMatchEntry) => `- **${e.lesson.title}** — ${lessonGist(e.lesson.body, 160)} \`${e.lesson.id}\``;
  const fixed = [...head, foot].reduce((n, l) => n + l.length + 1, 0);
  const all = ranked.map(line);
  const room = budget - fixed;
  let capped = capLines(all, Math.max(0, room));
  // 넘치면 '외 N개' 한 줄 몫(최대 자릿수 기준)을 비우고 다시 담는다 — 개수는 항상 드러낸다.
  if (capped.omitted) capped = capLines(all, Math.max(0, room - more(all.length).length - 1));
  if (!capped.lines.length) return { mentionedProjectIds: mentioned, ranked, markdown: "", lessonIds: [] };
  const lines = [...head, ...capped.lines, ...(capped.omitted ? [more(capped.omitted)] : []), foot];
  return {
    mentionedProjectIds: mentioned,
    ranked,
    markdown: lines.join("\n"),
    lessonIds: ranked.slice(0, capped.lines.length).map((e) => e.lesson.id),
  };
}
