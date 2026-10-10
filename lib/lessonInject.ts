/* =====================================================================
   레슨 주입 렌더링(순수) — /api/context 가 세션 컨텍스트에 레슨을 넣는 방식.

   종전 방식의 문제(2026-09-15 확인):
   ① take:50 + projectId asc 정렬이라 프로젝트 레슨이 많으면 **전역 레슨이 조용히 잘렸다**
      (로요 cwd 에서 전역 52개 중 27개 누락).
   ② 본문을 통째로 넣어 컨텍스트가 50KB 를 넘었고, Claude Code 는 큰 훅 출력을 파일로 빼고
      **앞 2KB 미리보기만** 세션에 넣었다 — 실제로 읽힌 레슨은 앞의 두세 개뿐이었다.
   ③ 본문 속 `## 제목` 이 컨텍스트의 섹션 구조를 깨뜨렸다.

   그래서 프로젝트 / 스택(Project.stack 과 맞는 것만) / 전역을 **섹션으로 나누고 각자 예산을 준다**. compact(세션 훅) 모드는
   제목 + 한 줄 요약 + id 만 넣고 전문은 필요할 때 조회하게 한다. 넘치면 제목만,
   그래도 넘치면 '외 N개' — 개수는 항상 드러낸다(조용히 버리지 않는다).
   ===================================================================== */

export type LessonLite = { id: string; title: string; body: string; projectId: string | null; stack?: string | null };

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

/** 한 섹션을 예산 안에 채운다 — **커버리지 우선**: 먼저 전부 제목 줄로 담고(넘치면 뒤에서 '외 N개'),
    남는 예산만큼 최근 것부터 요약 줄로 올린다. 몇 개의 긴 요약보다 모든 규칙의 이름이 보이는 게 낫다.
    gist = 요약 줄로 올라간 개수(앞에서부터), shown = 제목 이상으로 보인 개수 — 나머지는 '외 N개'. */
function fillSection(list: LessonLite[], budget: number): { lines: string[]; used: number; gist: number; shown: number } {
  const titles = list.map(titleLine);
  const moreLine = (n: number) => `- … 외 ${n}개 (전체 제목: MCP \`lesson_list\`)`;
  let shown = titles.length;
  while (shown > 0 && size(titles.slice(0, shown)) + (shown < list.length ? moreLine(list.length - shown).length + 1 : 0) > budget) shown--;
  const lines = titles.slice(0, shown);
  let used = size(lines) + (shown < list.length ? moreLine(list.length - shown).length + 1 : 0);
  let gist = 0;
  for (let i = 0; i < shown; i++) {
    const upgraded = compactLine(list[i]);
    const delta = upgraded.length - lines[i].length;
    if (used + delta > budget) break;
    lines[i] = upgraded;
    used += delta;
    gist++;
  }
  if (shown < list.length) lines.push(moreLine(list.length - shown));
  return { lines, used, gist, shown };
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

/** 섹션 예산 배분: 레슨 **개수에 비례**해 몫을 정하되, 필요량보다 적게 쓰는 섹션의 남는 몫은 나머지에 다시 나눈다.
    (균등 분할이면 22개짜리 전역과 44개짜리 프로젝트가 같은 몫을 받아 프로젝트 레슨이 잘렸다.) */
function allocate(needs: number[], counts: number[], budget: number): number[] {
  const alloc = needs.map(() => 0);
  let open = needs.map((_, i) => i).filter((i) => counts[i] > 0);
  let left = budget;
  while (open.length) {
    const total = open.reduce((n, i) => n + counts[i], 0);
    const capped = open.filter((i) => needs[i] <= Math.floor((left * counts[i]) / total));
    if (!capped.length) {
      for (const i of open) alloc[i] = Math.floor((left * counts[i]) / total);
      break;
    }
    for (const i of capped) {
      alloc[i] = needs[i];
      left -= needs[i];
    }
    open = open.filter((i) => !capped.includes(i));
  }
  return alloc;
}

/** 레슨별 주입 상태 — gist: 제목+요약 / title: 제목만 / omitted: '외 N개' 로만 셈 / not_applicable: 이 세션 대상 아님. */
export type LessonStatus = "gist" | "title" | "omitted" | "not_applicable";
export type LessonScope = "project" | "stack" | "global";
export type NotApplicableReason = "other_project" | "stack_mismatch";

export type LessonSectionReport = {
  kind: LessonScope;
  /** 스택 섹션의 태그 */
  tag: string | null;
  count: number;
  /** compact 에서 이 섹션에 배분된 예산(문자). full 은 null */
  budget: number | null;
  /** 실제로 쓴 문자(줄바꿈 포함, 섹션 제목 줄 제외) */
  used: number;
  gist: number;
  title: number;
  omitted: number;
};

export type LessonRenderReport = {
  mode: "full" | "compact";
  /** 레슨 섹션 전체 예산(compact) */
  budget: number | null;
  /** 레슨 섹션 글자 수(lines.join("\n")) */
  chars: number;
  sections: LessonSectionReport[];
  statuses: { id: string; scope: LessonScope; status: LessonStatus; reason?: NotApplicableReason }[];
};

export function renderLessons(i: {
  lessons: LessonLite[];
  projectId: string | null;
  projectName: string | null;
  projectStack?: string[];
  mode: "full" | "compact";
  budget?: number;
}): string[] {
  return renderLessonsReport(i).lines;
}

/** renderLessons 와 같은 출력 + 레슨별 상태·섹션 예산 사용(레슨 주입 점검 화면용). 출력 줄은 renderLessons 와 바이트 단위로 같다. */
export function renderLessonsReport(i: {
  lessons: LessonLite[];
  projectId: string | null;
  projectName: string | null;
  projectStack?: string[];
  mode: "full" | "compact";
  budget?: number;
}): { lines: string[]; report: LessonRenderReport } {
  const stackSet = new Set(i.projectId ? (i.projectStack ?? []) : []);
  const project = i.projectId ? i.lessons.filter((l) => l.projectId === i.projectId) : [];
  const global = i.lessons.filter((l) => !l.projectId && !l.stack);
  const stackLessons = i.lessons.filter((l) => !l.projectId && l.stack);
  const byStack = [...stackSet].map((tag) => ({ tag, list: stackLessons.filter((l) => l.stack === tag) })).filter((x) => x.list.length);
  const skippedStack = stackLessons.filter((l) => !stackSet.has(l.stack as string)).length;
  const stackCount = byStack.reduce((n, x) => n + x.list.length, 0);

  const out: string[] = [];
  const head = [
    project.length ? `프로젝트 ${project.length}` : null,
    stackCount ? `스택 ${stackCount}` : null,
    `전역 ${global.length}`,
  ].filter(Boolean).join(" · ");
  out.push(`## 팀 작업규칙·레슨 — 반드시 따른다 (${head})`);

  const sections: { title: string; list: LessonLite[]; kind: LessonScope; tag: string | null }[] = [];
  if (i.projectId) sections.push({ title: `### 프로젝트: ${i.projectName ?? "현재 프로젝트"} (${project.length})`, list: project, kind: "project", tag: null });
  for (const x of byStack) sections.push({ title: `### 스택: ${x.tag} (${x.list.length})`, list: x.list, kind: "stack", tag: x.tag });
  sections.push({ title: `### 전역 (${global.length})`, list: global, kind: "global", tag: null });

  const statusById = new Map<string, { scope: LessonScope; status: LessonStatus }>();
  const secReports: LessonSectionReport[] = [];
  let budgetOut: number | null = null;

  if (i.mode === "full") {
    for (const sec of sections) {
      out.push(sec.title);
      if (sec.list.length === 0) out.push("- (없음)");
      const lines = sec.list.map(fullLine);
      out.push(...lines);
      for (const l of sec.list) statusById.set(l.id, { scope: sec.kind, status: "gist" });
      secReports.push({ kind: sec.kind, tag: sec.tag, count: sec.list.length, budget: null, used: size(lines), gist: sec.list.length, title: 0, omitted: 0 });
    }
  } else {
    const budget = i.budget ?? LESSON_BUDGET;
    budgetOut = budget;
    const alloc = allocate(sections.map((sec) => size(sec.list.map(compactLine))), sections.map((sec) => sec.list.length), budget);
    sections.forEach((sec, idx) => {
      out.push(sec.title);
      if (sec.list.length === 0) {
        secReports.push({ kind: sec.kind, tag: sec.tag, count: 0, budget: alloc[idx], used: 0, gist: 0, title: 0, omitted: 0 });
        return void out.push("- (없음)");
      }
      const r = fillSection(sec.list, alloc[idx]);
      out.push(...r.lines);
      sec.list.forEach((l, k) => statusById.set(l.id, { scope: sec.kind, status: k < r.gist ? "gist" : k < r.shown ? "title" : "omitted" }));
      secReports.push({ kind: sec.kind, tag: sec.tag, count: sec.list.length, budget: alloc[idx], used: r.used, gist: r.gist, title: r.shown - r.gist, omitted: sec.list.length - r.shown });
    });
    out.push("_전문은 관련 작업을 시작할 때 읽는다: MCP `lesson_get {id}` (TeamSpace 레포에서는 `pnpm ws lesson show <id>`)._");
  }
  if (skippedStack) {
    out.push(`_스택 레슨 ${skippedStack}개는 이 세션의 프로젝트 스택과 맞지 않거나 프로젝트가 매핑되지 않아 제외했다._`);
  }
  out.push("");

  const statuses = i.lessons.map((l) => {
    const hit = statusById.get(l.id);
    if (hit) return { id: l.id, ...hit };
    const scope: LessonScope = l.projectId ? "project" : l.stack ? "stack" : "global";
    const reason: NotApplicableReason = l.projectId ? "other_project" : "stack_mismatch";
    return { id: l.id, scope, status: "not_applicable" as const, reason };
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
  compact: boolean;
  restChars: number;
}): { lines: string[]; report: LessonRenderReport & { restChars: number } } {
  const r = renderLessonsReport({
    lessons: i.lessons,
    projectId: i.projectId,
    projectName: i.projectName,
    projectStack: i.projectStack,
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
