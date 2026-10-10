/* =====================================================================
   레슨 주입 렌더링(순수) — /api/context 가 세션 컨텍스트에 레슨을 넣는 방식.

   종전 방식의 문제(2026-09-15 확인):
   ① take:50 + projectId asc 정렬이라 프로젝트 레슨이 많으면 **전역 레슨이 조용히 잘렸다**
      (로요 cwd 에서 전역 52개 중 27개 누락).
   ② 본문을 통째로 넣어 컨텍스트가 50KB 를 넘었고, Claude Code 는 큰 훅 출력을 파일로 빼고
      **앞 2KB 미리보기만** 세션에 넣었다 — 실제로 읽힌 레슨은 앞의 두세 개뿐이었다.
   ③ 본문 속 `## 제목` 이 컨텍스트의 섹션 구조를 깨뜨렸다.

   그래서 프로젝트 / 스택(Project.stack 과 맞는 것만) / 전역을 **섹션으로 나눈다**. compact(세션 훅) 모드는
   제목 + 한 줄 요약 + id 만 넣고 전문은 필요할 때 조회하게 한다. 넘치면 제목만,
   그래도 넘치면 '외 N개' — 개수는 항상 드러낸다(조용히 버리지 않는다).

   범위·주입 방식 개편(2026-10-10, TeamSpace doc '레슨 범위·주입 방식 개편 설계'):
   범위에 **개인**(Lesson.userId — 그 사람·그 사람이 발급한 토큰의 세션에만)을 더하고, 레슨마다 주입 방식
   (required 필수 · default 기본 · ondemand 필요할 때만)을 둔다. 예산은 **필수 먼저**(범위 무관, 제목+요약),
   남은 예산을 **좁은 범위부터**(개인 → 프로젝트 → 스택 → 전역) 채운다 — 개수 비례 배분은 그만뒀다.
   ondemand 는 세션 주입에서 빼고 개수만 한 줄로 알린다.
   ===================================================================== */

export type LessonLite = {
  id: string;
  title: string;
  body: string;
  projectId: string | null;
  stack?: string | null;
  /** 개인 레슨의 주인(사람 User.id). null/undefined = 개인 아님 */
  userId?: string | null;
  /** required | default | ondemand (모르는 값·없음 = default) */
  mode?: string | null;
};

export const LESSON_BUDGET = 5000;
/** 세션 훅 주입 전체 목표(문자). Claude Code 는 큰 훅 출력을 파일로 빼고 앞 2KB 만 넣는다 — 53KB 에서 실측, 9KB 는 본문으로 들어감을 확인(2026-09-15). */
export const CONTEXT_BUDGET = 9000;

export function neutralizeHeadings(body: string): string {
  return body.replace(/^#{1,6}\s+/gm, "▸ ");
}

export function gistOf(body: string, max: number): string {
  const flat = body
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** 레슨 한 줄 요약. 레슨 본문은 '실사례 → 원인 → 처방' 순서라 앞머리가 서두다 —
    처방·교훈이 있으면 거기서부터, 없으면 첫 '실사례(...).' 문장을 건너뛰고 요약한다. */
export function lessonGist(body: string, max: number): string {
  const m = body.match(/(?:처방|교훈)\s*\d*\s*[:：]\s*([\s\S]*)/);
  if (m) return gistOf(m[1], max);
  return gistOf(body.replace(/^\s*실사례\([^)]*\)\s*[.:：]?\s*/, ""), max);
}

/** 줄 목록을 문자 예산 안에서 앞에서부터 담는다(줄바꿈 1자 포함). */
export function capLines(lines: string[], budget: number): { lines: string[]; omitted: number; used: number } {
  const out: string[] = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > budget) break;
    out.push(l);
    used += l.length + 1;
  }
  return { lines: out, omitted: lines.length - out.length, used };
}

const compactLine = (l: LessonLite) => `- **${l.title}** — ${lessonGist(l.body, 110)} \`${l.id}\``;
const titleLine = (l: LessonLite) => `- **${l.title}** \`${l.id}\``;
const fullLine = (l: LessonLite) => `- **${l.title}**: ${neutralizeHeadings(l.body)}`;
const size = (lines: string[]) => lines.reduce((n, l) => n + l.length + 1, 0);
const moreLine = (n: number) => `- … 외 ${n}개 (전체 제목: MCP \`lesson_list\`)`;
const moreCost = (n: number) => (n > 0 ? moreLine(n).length + 1 : 0);

/** 한 섹션을 예산 안에 채운다 — **커버리지 우선**: 먼저 전부 제목 줄로 담고(넘치면 뒤에서 '외 N개'),
    남는 예산만큼 최근 것부터 요약 줄로 올린다. 몇 개의 긴 요약보다 모든 규칙의 이름이 보이는 게 낫다.
    gist = 요약 줄로 올라간 개수(앞에서부터), shown = 제목 이상으로 보인 개수 — 나머지는 '외 N개'.
    필수 섹션이 이걸 쓴다(예산 안이면 전부 요약, 넘치면 제목만 → '외 N개' 로 떨어진다). */
function fillSection(list: LessonLite[], budget: number): { lines: string[]; used: number; gist: number; shown: number } {
  const r = fillOrdered([list], budget)[0];
  return { lines: r.lines, used: r.used, gist: r.gist, shown: r.shown };
}

/** 여러 섹션을 **좁은 범위부터**(배열 순서) 한 예산 안에 채운다 — 개인 → 프로젝트 → 스택 → 전역.
    ① 제목 단계: 앞 섹션부터 제목 줄을 담는다. 뒤 섹션이 최악의 경우에도 '외 N개' 한 줄은 낼 수 있게 그 몫은 남겨 둔다
       (조용히 버리지 않는다 — 개수는 항상 드러낸다).
    ② 요약 단계: 남은 예산으로 앞 섹션부터, 섹션 안에서는 최근 것부터 요약 줄로 올린다.
    커버리지(모든 규칙의 이름)를 먼저 지키고, 그 위에서 좁은 범위가 요약을 먼저 가져간다. */
function fillOrdered(lists: LessonLite[][], budget: number): { lines: string[]; used: number; gist: number; shown: number }[] {
  const res = lists.map((list) => ({ lines: list.map(titleLine), used: 0, gist: 0, shown: list.length }));
  let left = budget;
  lists.forEach((list, s) => {
    const reserve = lists.slice(s + 1).reduce((n, l) => n + moreCost(l.length), 0);
    const avail = Math.max(0, left - reserve);
    const titles = res[s].lines;
    let shown = list.length;
    while (shown > 0 && size(titles.slice(0, shown)) + moreCost(list.length - shown) > avail) shown--;
    res[s].lines = titles.slice(0, shown);
    res[s].shown = shown;
    res[s].used = size(res[s].lines) + moreCost(list.length - shown);
    left -= res[s].used;
  });
  lists.forEach((list, s) => {
    const r = res[s];
    for (let k = 0; k < r.shown; k++) {
      const upgraded = compactLine(list[k]);
      const delta = upgraded.length - r.lines[k].length;
      if (delta > left) break;
      r.lines[k] = upgraded;
      r.used += delta;
      left -= delta;
      r.gist++;
    }
    if (r.shown < list.length) r.lines.push(moreLine(list.length - r.shown));
  });
  return res;
}

const STACK_RE = /^[a-z0-9][a-z0-9.+-]{0,31}$/;

/** 스택 태그 정규화 — "Next, supabase" | ["next"] → ["next","supabase"]. 공백·특수문자 태그는 거절. */
export function normalizeStack(raw: unknown): { ok: true; stack: string[] } | { ok: false; error: string } {
  const parts = (Array.isArray(raw) ? raw : String(raw ?? "").split(","))
    .map((x) => String(x).trim().toLowerCase())
    .filter(Boolean);
  const bad = parts.filter((x) => !STACK_RE.test(x));
  if (bad.length) return { ok: false, error: `스택 태그는 소문자·숫자·.+- 만 씁니다: ${bad.join(", ")}` };
  return { ok: true, stack: [...new Set(parts)] };
}

/* ── 범위·주입 방식 ─────────────────────────────────────────────────── */

/** 주입 방식 — required: 필수(범위 안이면 항상 제목+요약, 예산을 먼저 가져간다) · default: 기본(제목 먼저, 남으면 요약)
    · ondemand: 필요할 때만(세션 시작 주입에서 뺀다 — 목록·검색·lesson_get 으로만 찾는다). */
export const LESSON_MODES = ["required", "default", "ondemand"] as const;
export type LessonMode = (typeof LESSON_MODES)[number];

export function lessonModeOf(l: { mode?: string | null }): LessonMode {
  return (LESSON_MODES as readonly string[]).includes(l.mode ?? "") ? (l.mode as LessonMode) : "default";
}

/** 주입 방식 입력 검증 — 모르는 값은 거절(조용히 default 로 바꾸지 않는다). */
export function parseLessonMode(raw: unknown): { ok: true; mode: LessonMode } | { ok: false; error: string } {
  const v = String(raw ?? "").trim().toLowerCase();
  if ((LESSON_MODES as readonly string[]).includes(v)) return { ok: true, mode: v as LessonMode };
  return { ok: false, error: `mode 는 ${LESSON_MODES.join("|")} 중 하나입니다.` };
}

/** 레슨 범위 — 개인(userId) · 프로젝트(projectId) · 스택(stack) · 전역(모두 null). 범위는 하나다. */
export type LessonScope = "personal" | "project" | "stack" | "global";

export function lessonScopeOf(l: { userId?: string | null; projectId: string | null; stack?: string | null }): LessonScope {
  return l.userId ? "personal" : l.projectId ? "project" : l.stack ? "stack" : "global";
}

/** 이 세션 대상이 아닌 사유 — other_project: 다른 프로젝트 · stack_mismatch: 스택 불일치(또는 프로젝트 미매핑)
    · other_person: 다른 사람의 개인 레슨 · ondemand: 범위 안이지만 '필요할 때만' 이라 주입하지 않음. */
export type NotApplicableReason = "other_project" | "stack_mismatch" | "other_person" | "ondemand";

/** 세션(프로젝트·스택·사람)에 이 레슨이 들어가는가 — null = 들어간다, 아니면 빠지는 사유.
    컨텍스트 라우트(compact·full)·brief·주입 기록·점검이 모두 이 함수로 판정한다(드리프트 방지). */
export function lessonApplicability(
  l: { userId?: string | null; projectId: string | null; stack?: string | null; mode?: string | null },
  s: { projectId: string | null; projectStack?: string[]; personId?: string | null },
): NotApplicableReason | null {
  const scope = lessonScopeOf(l);
  if (scope === "personal" && (!s.personId || l.userId !== s.personId)) return "other_person";
  if (scope === "project" && l.projectId !== s.projectId) return "other_project";
  if (scope === "stack" && !(s.projectId && (s.projectStack ?? []).includes(l.stack as string))) return "stack_mismatch";
  if (lessonModeOf(l) === "ondemand") return "ondemand";
  return null;
}

/** 레슨별 주입 상태 — gist: 제목+요약 / title: 제목만 / omitted: '외 N개' 로만 셈 / not_applicable: 이 세션 대상 아님. */
export type LessonStatus = "gist" | "title" | "omitted" | "not_applicable";

export type LessonSectionReport = {
  /** required = 필수 섹션(범위 무관, 예산을 먼저 가져간다) */
  kind: LessonScope | "required";
  /** 스택 섹션의 태그 */
  tag: string | null;
  count: number;
  /** compact 에서 이 섹션이 받은 예산(문자) — 좁은 범위부터 채우므로 고정 몫이 아니라 실제로 받은 만큼(= used). full 은 null */
  budget: number | null;
  /** 실제로 쓴 문자(줄바꿈 포함, 섹션 제목 줄 제외) */
  used: number;
  gist: number;
  title: number;
  omitted: number;
};

export type LessonStatusEntry = { id: string; scope: LessonScope; mode: LessonMode; status: LessonStatus; reason?: NotApplicableReason };

export type LessonRenderReport = {
  mode: "full" | "compact";
  /** 레슨 섹션 전체 예산(compact) */
  budget: number | null;
  /** 레슨 섹션 글자 수(lines.join("\n")) */
  chars: number;
  sections: LessonSectionReport[];
  statuses: LessonStatusEntry[];
};

type RenderInput = {
  lessons: LessonLite[];
  projectId: string | null;
  projectName: string | null;
  projectStack?: string[];
  /** 이 세션의 사람(사람 세션 = 본인, 에이전트 토큰 = 발급자). 개인 레슨은 이 사람 것만 들어간다. */
  personId?: string | null;
  mode: "full" | "compact";
  budget?: number;
};

export function renderLessons(i: RenderInput): string[] {
  return renderLessonsReport(i).lines;
}

/** renderLessons 와 같은 출력 + 레슨별 상태·섹션 예산 사용(레슨 주입 점검 화면용). 출력 줄은 renderLessons 와 바이트 단위로 같다.
    예산 순서: **필수 먼저**(범위 무관, 제목+요약) → 남은 예산을 좁은 범위부터(개인 → 프로젝트 → 스택 → 전역). */
export function renderLessonsReport(i: RenderInput): { lines: string[]; report: LessonRenderReport } {
  const stackSet = new Set(i.projectId ? (i.projectStack ?? []) : []);
  const scopeCtx = { projectId: i.projectId, projectStack: [...stackSet], personId: i.personId ?? null };
  const reasonById = new Map(i.lessons.map((l) => [l.id, lessonApplicability(l, scopeCtx)]));
  const live = i.lessons.filter((l) => reasonById.get(l.id) === null);
  const required = live.filter((l) => lessonModeOf(l) === "required");
  const rest = live.filter((l) => lessonModeOf(l) !== "required");
  const personal = rest.filter((l) => lessonScopeOf(l) === "personal");
  const project = rest.filter((l) => lessonScopeOf(l) === "project");
  const global = rest.filter((l) => lessonScopeOf(l) === "global");
  const stackLive = rest.filter((l) => lessonScopeOf(l) === "stack");
  const byStack = [...stackSet].map((tag) => ({ tag, list: stackLive.filter((l) => l.stack === tag) })).filter((x) => x.list.length);
  const skippedStack = i.lessons.filter((l) => reasonById.get(l.id) === "stack_mismatch").length;
  const ondemandN = i.lessons.filter((l) => reasonById.get(l.id) === "ondemand").length;
  const stackCount = byStack.reduce((n, x) => n + x.list.length, 0);

  const out: string[] = [];
  const head = [
    required.length ? `필수 ${required.length}` : null,
    personal.length ? `개인 ${personal.length}` : null,
    project.length ? `프로젝트 ${project.length}` : null,
    stackCount ? `스택 ${stackCount}` : null,
    `전역 ${global.length}`,
  ].filter(Boolean).join(" · ");
  out.push(`## 팀 작업규칙·레슨 — 반드시 따른다 (${head})`);

  type Sec = { title: string; list: LessonLite[]; kind: LessonScope | "required"; tag: string | null };
  const reqSec: Sec | null = required.length ? { title: `### 필수 (${required.length})`, list: required, kind: "required", tag: null } : null;
  const sections: Sec[] = [];
  if (personal.length) sections.push({ title: `### 개인 (${personal.length})`, list: personal, kind: "personal", tag: null });
  if (i.projectId) sections.push({ title: `### 프로젝트: ${i.projectName ?? "현재 프로젝트"} (${project.length})`, list: project, kind: "project", tag: null });
  for (const x of byStack) sections.push({ title: `### 스택: ${x.tag} (${x.list.length})`, list: x.list, kind: "stack", tag: x.tag });
  sections.push({ title: `### 전역 (${global.length})`, list: global, kind: "global", tag: null });
  const all = reqSec ? [reqSec, ...sections] : sections;

  const statusById = new Map<string, LessonStatus>();
  const secReports: LessonSectionReport[] = [];
  let budgetOut: number | null = null;
  const report = (sec: Sec, budget: number | null, used: number, gist: number, shown: number) =>
    secReports.push({ kind: sec.kind, tag: sec.tag, count: sec.list.length, budget, used, gist, title: shown - gist, omitted: sec.list.length - shown });

  if (i.mode === "full") {
    for (const sec of all) {
      out.push(sec.title);
      if (sec.list.length === 0) out.push("- (없음)");
      const lines = sec.list.map(fullLine);
      out.push(...lines);
      for (const l of sec.list) statusById.set(l.id, "gist");
      report(sec, null, size(lines), sec.list.length, sec.list.length);
    }
  } else {
    const budget = i.budget ?? LESSON_BUDGET;
    budgetOut = budget;
    let left = budget;
    const fills: { sec: Sec; r: { lines: string[]; used: number; gist: number; shown: number } }[] = [];
    if (reqSec) {
      // 필수가 예산을 먼저 가져간다. 넘치면 필수도 제목만 → '외 N개'(fillSection 의 커버리지 우선 규칙).
      const r = fillSection(reqSec.list, budget);
      fills.push({ sec: reqSec, r });
      left -= r.used;
    }
    const rs = fillOrdered(sections.map((s) => s.list), Math.max(0, left));
    sections.forEach((sec, k) => fills.push({ sec, r: rs[k] }));
    for (const { sec, r } of fills) {
      out.push(sec.title);
      if (sec.list.length === 0) {
        out.push("- (없음)");
        report(sec, 0, 0, 0, 0);
        continue;
      }
      out.push(...r.lines);
      sec.list.forEach((l, k) => statusById.set(l.id, k < r.gist ? "gist" : k < r.shown ? "title" : "omitted"));
      report(sec, r.used, r.used, r.gist, r.shown);
    }
    out.push("_전문은 관련 작업을 시작할 때 읽는다: MCP `lesson_get {id}` (TeamSpace 레포에서는 `pnpm ws lesson show <id>`)._");
  }
  if (skippedStack) {
    out.push(`_스택 레슨 ${skippedStack}개는 이 세션의 프로젝트 스택과 맞지 않거나 프로젝트가 매핑되지 않아 제외했다._`);
  }
  if (ondemandN) {
    out.push(`_'필요할 때만' 레슨 ${ondemandN}개는 넣지 않았다 — 관련 작업이면 MCP \`lesson_list\`(q=제목 검색)로 찾는다._`);
  }
  out.push("");

  const statuses: LessonStatusEntry[] = i.lessons.map((l) => {
    const base = { id: l.id, scope: lessonScopeOf(l), mode: lessonModeOf(l) };
    const st = statusById.get(l.id);
    if (st) return { ...base, status: st };
    return { ...base, status: "not_applicable" as const, reason: reasonById.get(l.id) ?? "other_project" };
  });
  return { lines: out, report: { mode: i.mode, budget: budgetOut, chars: out.join("\n").length, sections: secReports, statuses } };
}

/** 세션 컨텍스트에서 레슨 섹션이 받는 예산: 전체 예산(CONTEXT_BUDGET)에서 다른 섹션이 쓰고 남은 만큼(최소 LESSON_BUDGET).
    태스크가 없는 레포(로요)는 레슨이 더 들어가고, 태스크가 많은 레포는 레슨이 최소 몫을 지킨다. */
export function lessonBudgetFor(restChars: number): number {
  return Math.max(LESSON_BUDGET, CONTEXT_BUDGET - restChars - 400);
}

/** /api/context 의 레슨 섹션 조립 — 라우트와 레슨 주입 점검(시뮬레이터)이 **같은 함수**를 쓴다(드리프트 방지).
    restChars = 레슨을 뺀 나머지 컨텍스트 글자 수(레슨은 나머지를 다 그린 뒤 끼운다). */
export function buildLessonSection(i: {
  lessons: LessonLite[];
  projectId: string | null;
  projectName: string | null;
  projectStack: string[];
  personId?: string | null;
  compact: boolean;
  restChars: number;
}): { lines: string[]; report: LessonRenderReport & { restChars: number } } {
  const r = renderLessonsReport({
    lessons: i.lessons,
    projectId: i.projectId,
    projectName: i.projectName,
    projectStack: i.projectStack,
    personId: i.personId ?? null,
    mode: i.compact ? "compact" : "full",
    budget: lessonBudgetFor(i.restChars),
  });
  return { lines: r.lines, report: { ...r.report, restChars: i.restChars } };
}

/** 레슨 스택은 태그 하나(null/빈 문자열 = 해제). */
export function parseLessonStack(raw: unknown): { ok: true; stack: string | null } | { ok: false; error: string } {
  if (raw === null || raw === "") return { ok: true, stack: null };
  const r = normalizeStack(raw);
  if (!r.ok) return r;
  if (r.stack.length !== 1) return { ok: false, error: "레슨 스택은 태그 하나만 지정합니다(예: next)." };
  return { ok: true, stack: r.stack[0] };
}
