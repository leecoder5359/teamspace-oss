/* =====================================================================
   프로젝트 델타(순수) — GET /api/context?sections=project. PostToolUse 훅이 세션 레포 밖의 매핑된
   프로젝트를 건드렸을 때 넣는 컨텍스트.

   종전엔 compact 전체(~9KB)를 다시 넣었는데, 그 절반 이상(필수·전역 레슨, 지식 지도, 용어집, 문서 목록)은
   세션 시작(SessionStart·SubagentStart)에 이미 들어가 있었다(감사 doc cmvfg2ytk). 여기서는 그 프로젝트에만
   있는 것 — 프로젝트·스택 범위 레슨(필수 먼저), 계정 줄, 내 담당·진행 중 태스크, 개수 한 줄 — 만 준다.
   ===================================================================== */
import { capLines, fillOrdered, lessonApplicability, lessonModeOf, lessonScopeOf, type LessonLite } from "@/lib/lessonInject";
import { briefTaskLines, type BriefTask } from "@/lib/contextBrief";
import { accountSection } from "@/lib/envVault/sessionAccounts";

/** 델타 전체 목표(문자). 반장 규모(프로젝트 레슨 수십·태스크 수백)에서 이 안이어야 한다. */
export const PROJECT_DELTA_TARGET = 3000;
/** 레슨 줄 예산(문자, 줄바꿈 포함) — 제목 먼저 전부, 남으면 필수부터 요약으로 올린다(fillOrdered). */
export const PROJECT_LESSON_BUDGET = 1500;

export type ProjectDeltaInput = {
  workspaceName: string;
  projectId: string | null;
  projectName: string | null;
  projectStack: string[];
  lessons: LessonLite[];
  personId?: string | null;
  tasks: BriefTask[];
  me: string[];
  counts: { tasks: number; docs: number; decisions: number };
  accountLines: string[];
};

export type InjectionIds = { gistIds: string[]; titleIds: string[]; omittedIds: string[] };

/** 이 프로젝트 범위(프로젝트·그 스택)이면서 세션 대상인 레슨 — 필수 먼저. */
function deltaLessons(i: ProjectDeltaInput): { required: LessonLite[]; rest: LessonLite[]; ondemand: number } {
  const scope = { projectId: i.projectId, projectStack: i.projectId ? i.projectStack : [], personId: i.personId ?? null };
  const inScope = i.lessons.filter((l) => {
    const s = lessonScopeOf(l);
    return s === "project" || s === "stack";
  });
  const reason = (l: LessonLite) => lessonApplicability(l, scope);
  const live = inScope.filter((l) => reason(l) === null);
  return {
    required: live.filter((l) => lessonModeOf(l) === "required"),
    rest: live.filter((l) => lessonModeOf(l) !== "required"),
    ondemand: inScope.filter((l) => reason(l) === "ondemand").length,
  };
}

export function renderProjectDelta(i: ProjectDeltaInput): { markdown: string; ids: InjectionIds } {
  const L: string[] = [];
  L.push(`# 워크스페이스: ${i.workspaceName}${i.projectName ? ` · 프로젝트: ${i.projectName}` : ""} (프로젝트 델타)`);
  L.push("_전역·개인·필수(전역) 레슨은 세션 시작에 이미 들어가 있다 — 여기는 이 프로젝트 범위(프로젝트·스택)만 더한다._");
  L.push("");
  L.push(...accountSection(i.accountLines));

  const { required, rest, ondemand } = deltaLessons(i);
  const head = [required.length ? `필수 ${required.length}` : null, `프로젝트·스택 ${rest.length}`].filter(Boolean).join(" · ");
  L.push(`## 프로젝트 레슨 — 반드시 따른다 (${head})`);
  const ids: InjectionIds = { gistIds: [], titleIds: [], omittedIds: [] };
  if (required.length + rest.length === 0) L.push("- (없음)");
  else {
    const lists = [required, rest];
    fillOrdered(lists, PROJECT_LESSON_BUDGET).forEach((r, s) => {
      L.push(...r.lines);
      lists[s].forEach((l, k) => (k < r.gist ? ids.gistIds : k < r.shown ? ids.titleIds : ids.omittedIds).push(l.id));
    });
  }
  L.push("_전문: MCP `lesson_get {id}` (TeamSpace 레포에서는 `pnpm ws lesson show <id>`)._");
  if (ondemand) L.push(`_'필요할 때만' 레슨 ${ondemand}개는 넣지 않았다 — MCP \`lesson_list\`(q=제목 검색)._`);
  L.push("");

  L.push(...briefTaskLines(i.tasks, i.me));
  L.push("");
  const c = i.counts;
  L.push(`태스크 ${c.tasks} · 문서 ${c.docs} · 결정 ${c.decisions} — MCP \`task_list\` · \`doc_list\` · \`search\``);
  // 레슨 예산·태스크 바이트 상한으로 보통은 목표 안이다. 계정 줄이 길게 붙는 극단만 여기서 끝을 자른다(개수 줄은 남긴다).
  const md = L.join("\n");
  if (md.length <= PROJECT_DELTA_TARGET) return { markdown: md, ids };
  const tail = L[L.length - 1];
  const body = capLines(L.slice(0, -1), PROJECT_DELTA_TARGET - tail.length - 1);
  return { markdown: [...body.lines, tail].join("\n"), ids };
}
