/* =====================================================================
   세션 컨텍스트 brief 모드(순수) — SessionStart 훅이 resume·compact 때 쓰는 요약.

   새 세션(startup·clear)은 compact 컨텍스트(~9KB)를 받는다. 그런데 이어가기(resume)·
   자동 압축(compact)마다 같은 14~17KB 가 다시 실려 대화 컨텍스트를 반복해서 먹었다.
   이어가는 세션은 이미 전체를 한 번 읽었으므로, 여기선 '지금 붙잡을 것'만 준다:
   필수·개인·프로젝트·스택 레슨 제목+id, 내 담당 + 진행 중 상위 5건, 나머지는 개수 한 줄.
   한도는 **바이트**로 잰다 — 한글은 UTF-8 로 3바이트라 글자 수로 재면 세 배까지 커진다.
   ===================================================================== */
import type { LessonLite } from "@/lib/lessonInject";
import { gistOf, lessonApplicability, lessonModeOf, lessonScopeOf } from "@/lib/lessonInject";
import { ACCOUNT_SECTION_TITLE } from "@/lib/envVault/sessionAccounts";

/** brief 전체 바이트 **목표치**(~2.5KB) — 강제 상한이 아니다. 실제로 자르는 건 섹션별 예산
 *  (LESSON_BYTES·TASK_BYTES, 넘치는 줄은 '외 N' 으로 접음)이고, 머리말·개수 줄까지 더한 최악은 ~2.7KB. */
export const BRIEF_BYTE_TARGET = 2500;
const LESSON_BYTES = 1000;
const TASK_BYTES = 1000;
const MIN_GROUP_BYTES = 280;
const IN_PROGRESS_TOP = 5;
const IN_PROGRESS_RE = /진행|progress|doing/i;

export type BriefTask = { title: string; status: string | null; due: string | null; assignee: string | null };

export type BriefInput = {
  workspaceName: string;
  projectId: string | null;
  projectName: string | null;
  projectStack: string[];
  lessons: LessonLite[];
  /** 이 세션의 사람(사람 세션 = 본인, 에이전트 토큰 = 발급자) — 개인 레슨은 이 사람 것만 */
  personId?: string | null;
  tasks: BriefTask[];
  /** 내 담당 판정에 쓸 값들 — claim 은 actor.name 을, person 속성은 userId 를 저장한다. */
  me: string[];
  counts: { docs: number; decisions: number; risks: number; glossary: number };
  /** env 금고 반영 대상의 기대 계정 줄(P3c) — brief 엔 가장 중요한 1줄만. 없거나 비면 섹션 자체를 그리지 않는다. */
  accountLines?: string[];
};

const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const usedBytes = (lines: string[]) => lines.reduce((n, l) => n + bytes(l) + 1, 0);

/** 줄 목록을 바이트 예산 안에서 앞에서부터 담는다(줄바꿈 1바이트 포함). 넘치면 more(n) 줄을 붙인다. */
function capBytes(lines: string[], budget: number, more: (n: number) => string): string[] {
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const rest = lines.length - i - 1;
    const tail = rest > 0 ? bytes(more(rest)) + 1 : 0;
    if (used + bytes(lines[i]) + 1 + tail > budget) {
      out.push(more(lines.length - i));
      return out;
    }
    out.push(lines[i]);
    used += bytes(lines[i]) + 1;
  }
  return out;
}

export function renderBrief(i: BriefInput): string {
  const L: string[] = [];
  L.push(`# 워크스페이스: ${i.workspaceName}${i.projectName ? ` · 프로젝트: ${i.projectName}` : ""}`);
  L.push("_요약 컨텍스트(이어가기·압축 후) — 세션 시작 때 받은 전체 규칙은 그대로 유효하다._");
  L.push("");
  if (i.accountLines?.length) L.push(ACCOUNT_SECTION_TITLE, i.accountLines[0], "");

  // 레슨: 필수(범위 무관) → 개인 → 프로젝트 → 프로젝트 스택과 맞는 스택 레슨 순서로 제목·id. 전역(기본)은 개수만.
  // 대상 판정은 compact 와 같은 함수(lessonApplicability) — 다른 사람의 개인 레슨·ondemand 는 빠진다.
  const scope = { projectId: i.projectId, projectStack: i.projectId ? i.projectStack : [], personId: i.personId ?? null };
  const live = i.lessons.filter((l) => lessonApplicability(l, scope) === null);
  const required = live.filter((l) => lessonModeOf(l) === "required");
  const rest = live.filter((l) => lessonModeOf(l) !== "required");
  const personal = rest.filter((l) => lessonScopeOf(l) === "personal");
  const project = rest.filter((l) => lessonScopeOf(l) === "project");
  const stack = rest.filter((l) => lessonScopeOf(l) === "stack");
  const globalN = rest.filter((l) => lessonScopeOf(l) === "global").length;
  const head = [
    required.length ? `필수 ${required.length}` : null,
    personal.length ? `개인 ${personal.length}` : null,
    project.length ? `프로젝트 ${project.length}` : null,
    stack.length ? `스택 ${stack.length}` : null,
    `전역 ${globalN}`,
  ]
    .filter(Boolean)
    .join(" · ");
  L.push(`## 팀 작업규칙·레슨 — 반드시 따른다 (${head})`);
  const lessonLine = (l: LessonLite) => `- ${gistOf(l.title, 60)} \`${l.id}\``;
  // 예산 순서는 compact 와 같다: 필수가 먼저 가져가고, 남은 바이트를 좁은 범위부터(개인 → 프로젝트·스택).
  const reqLines = capBytes(required.map(lessonLine), LESSON_BYTES, (n) => `- … 필수 외 ${n}개`);
  L.push(...reqLines);
  let left = Math.max(0, LESSON_BYTES - usedBytes(reqLines));
  const laterGroups = (project.length ? 1 : 0) + (stack.length ? 1 : 0);
  const personalLines = capBytes(personal.map(lessonLine), Math.max(0, left - laterGroups * MIN_GROUP_BYTES), (n) => `- … 개인 외 ${n}개`);
  L.push(...personalLines);
  left = Math.max(0, left - usedBytes(personalLines));
  // 프로젝트·스택: 개수 비례로 나누되 각 그룹이 최소 몇 줄은 보이게 한다(프로젝트 레슨이 스택을 통째로 밀어내지 않게).
  const total = project.length + stack.length;
  const stackBudget = stack.length ? Math.min(left, Math.max(MIN_GROUP_BYTES, Math.floor((left * stack.length) / total))) : 0;
  const projectBudget = left - stackBudget;
  L.push(...capBytes(project.map(lessonLine), projectBudget, (n) => `- … 프로젝트 외 ${n}개`));
  L.push(...capBytes(stack.map(lessonLine), stackBudget, (n) => `- … 스택 외 ${n}개`));
  L.push(`_전역 ${globalN}건 — MCP lesson_list · 전문은 MCP lesson_get {id}_`);
  L.push("");

  // 태스크: 내 담당(진행 중 먼저) + 그 밖의 진행 중 상위 5건. 두 묶음은 예산을 따로 써서 한쪽이 다른 쪽을 밀어내지 않는다.
  const me = new Set(i.me.filter(Boolean));
  const isMine = (t: BriefTask) => !!t.assignee && me.has(t.assignee);
  const isInProg = (t: BriefTask) => !!t.status && IN_PROGRESS_RE.test(t.status);
  const mine = i.tasks.filter(isMine).sort((a, b) => Number(isInProg(b)) - Number(isInProg(a)));
  const others = i.tasks.filter((t) => !isMine(t) && isInProg(t));
  const inProg = others.slice(0, IN_PROGRESS_TOP);
  L.push(`## 열린 태스크 ${i.tasks.length}건 — 내 담당 ${mine.length} · 진행 중 ${others.length + mine.filter(isInProg).length}`);
  if (mine.length + inProg.length === 0) L.push(i.tasks.length ? "- (내 담당·진행 중 없음)" : "- (열린 태스크 없음)");
  const taskLine = (t: BriefTask) => {
    const meta = [t.status, isMine(t) ? "나" : t.assignee, t.due ? `마감 ${t.due}` : null].filter(Boolean).join(" · ");
    return `- ${gistOf(t.title, 40)}${meta ? ` — ${meta}` : ""}`;
  };
  L.push(...capBytes(mine.map(taskLine), TASK_BYTES / 2, (n) => `- … 내 담당 외 ${n}건`));
  L.push(...capBytes(inProg.map(taskLine), TASK_BYTES / 2, (n) => `- … 진행 중 외 ${n}건`));
  L.push("_나머지 태스크: MCP task_list_");
  L.push("");

  const c = i.counts;
  L.push(`문서 ${c.docs} · 결정 ${c.decisions} · 리스크 ${c.risks} · 용어 ${c.glossary} · 지식 지도 — MCP context_get`);
  return L.join("\n");
}
