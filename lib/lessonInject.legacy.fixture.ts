/* 레슨 주입 렌더러의 리팩터 전(a7fc984) 사본 — lessonInject.test.ts 가 새 buildLessonSection 과
   출력이 바이트 단위로 같은지 비교하는 기준. 수정 금지(동작을 바꾸려면 이 기준 비교 테스트를 함께 바꾼다). */
import { lessonGist, neutralizeHeadings, LESSON_BUDGET, CONTEXT_BUDGET, type LessonLite } from "./lessonInject";

const compactLine = (l: LessonLite) => `- **${l.title}** — ${lessonGist(l.body, 110)} \`${l.id}\``;
const titleLine = (l: LessonLite) => `- **${l.title}** \`${l.id}\``;
const fullLine = (l: LessonLite) => `- **${l.title}**: ${neutralizeHeadings(l.body)}`;
const size = (lines: string[]) => lines.reduce((n, l) => n + l.length + 1, 0);

/** 한 섹션을 예산 안에 채운다 — **커버리지 우선**: 먼저 전부 제목 줄로 담고(넘치면 뒤에서 '외 N개'),
    남는 예산만큼 최근 것부터 요약 줄로 올린다. 몇 개의 긴 요약보다 모든 규칙의 이름이 보이는 게 낫다. */
function fillSection(list: LessonLite[], budget: number): { lines: string[]; used: number } {
  const titles = list.map(titleLine);
  const moreLine = (n: number) => `- … 외 ${n}개 (전체 제목: MCP \`lesson_list\`)`;
  let shown = titles.length;
  while (shown > 0 && size(titles.slice(0, shown)) + (shown < list.length ? moreLine(list.length - shown).length + 1 : 0) > budget) shown--;
  const lines = titles.slice(0, shown);
  let used = size(lines) + (shown < list.length ? moreLine(list.length - shown).length + 1 : 0);
  for (let i = 0; i < shown; i++) {
    const upgraded = compactLine(list[i]);
    const delta = upgraded.length - lines[i].length;
    if (used + delta > budget) break;
    lines[i] = upgraded;
    used += delta;
  }
  if (shown < list.length) lines.push(moreLine(list.length - shown));
  return { lines, used };
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

export function legacyRenderLessons(i: {
  lessons: LessonLite[];
  projectId: string | null;
  projectName: string | null;
  projectStack?: string[];
  mode: "full" | "compact";
  budget?: number;
}): string[] {
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

  const sections: { title: string; list: LessonLite[] }[] = [];
  if (i.projectId) sections.push({ title: `### 프로젝트: ${i.projectName ?? "현재 프로젝트"} (${project.length})`, list: project });
  for (const x of byStack) sections.push({ title: `### 스택: ${x.tag} (${x.list.length})`, list: x.list });
  sections.push({ title: `### 전역 (${global.length})`, list: global });

  if (i.mode === "full") {
    for (const sec of sections) {
      out.push(sec.title);
      if (sec.list.length === 0) out.push("- (없음)");
      for (const l of sec.list) out.push(fullLine(l));
    }
  } else {
    const budget = i.budget ?? LESSON_BUDGET;
    const alloc = allocate(sections.map((sec) => size(sec.list.map(compactLine))), sections.map((sec) => sec.list.length), budget);
    sections.forEach((sec, idx) => {
      out.push(sec.title);
      if (sec.list.length === 0) return void out.push("- (없음)");
      out.push(...fillSection(sec.list, alloc[idx]).lines);
    });
    out.push("_전문은 관련 작업을 시작할 때 읽는다: MCP `lesson_get {id}` (TeamSpace 레포에서는 `pnpm ws lesson show <id>`)._");
  }
  if (skippedStack) {
    out.push(`_스택 레슨 ${skippedStack}개는 이 세션의 프로젝트 스택과 맞지 않거나 프로젝트가 매핑되지 않아 제외했다._`);
  }
  out.push("");
  return out;
}

/** 리팩터 전 /api/context 의 레슨 예산 계산 */
export const legacyLessonBudget = (restChars: number) => Math.max(LESSON_BUDGET, CONTEXT_BUDGET - restChars - 400);
