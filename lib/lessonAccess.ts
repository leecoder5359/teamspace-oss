/* 레슨 접근 규칙(순수) — 개인 레슨(Lesson.userId)은 그 사람(과 그 사람이 발급한 토큰)만 목록·조회·수정한다.
   admin 은 관리용으로 목록·조회·수정·삭제할 수 있다. 단 **주입**은 언제나 본인 것만(lib/lessonInject.lessonApplicability). */
import type { Role } from "@/app/generated/prisma/enums";
import { lessonModeOf, lessonScopeOf } from "@/lib/lessonInject";

export function canSeeLesson(lesson: { userId?: string | null }, viewer: { personId: string | null; role: Role | string }): boolean {
  if (!lesson.userId) return true;
  if (viewer.role === "admin") return true;
  return !!viewer.personId && lesson.userId === viewer.personId;
}

/** 목록 where 조각 — admin 이 아니면 개인 레슨은 본인 것만. */
export function personalLessonWhere(viewer: { personId: string | null; role: Role | string }): { OR: ({ userId: null } | { userId: string })[] } | null {
  if (viewer.role === "admin") return null;
  return { OR: [{ userId: null }, ...(viewer.personId ? [{ userId: viewer.personId }] : [])] };
}

/** 응답용 — scope(personal|project|stack|global)·personal·mode 를 붙인다(mode 는 정규화). */
export function withLessonMeta<T extends { userId?: string | null; projectId: string | null; stack?: string | null; mode?: string | null }>(
  l: T,
): T & { scope: ReturnType<typeof lessonScopeOf>; personal: boolean; mode: ReturnType<typeof lessonModeOf> } {
  return { ...l, scope: lessonScopeOf(l), personal: !!l.userId, mode: lessonModeOf(l) };
}

export const PERSONAL_SCOPE_CONFLICT = "개인 레슨은 프로젝트·스택과 함께 정할 수 없습니다(범위는 하나: 개인·프로젝트·스택·전역).";
export const PERSONAL_NEEDS_PERSON = "개인 레슨을 만들 사람을 알 수 없습니다 — 사람 로그인이나 발급자가 기록된 에이전트 토큰으로 요청하세요.";

/* ── 레슨 공유·가져오기(2026-10-18) ─────────────────────────────────────────
   공개(sharedWithTeam)는 "팀원 레슨 목록에서 보인다"일 뿐 — 주입은 여전히 주인 것만(lessonApplicability).
   가져온 복사본(copiedFromId 있음)은 팀원 탭에 다시 나오지 않는다 — 원작자에게 메아리치지 않게. */

type Viewer = { personId: string | null; role: Role | string };

export type LessonListScope = "team" | "mine" | "teammates";

/** GET /api/lessons ?scope= — 없음·빈칸은 null(종전: 팀 + 내 개인, admin 은 전부). */
export function parseLessonListScope(raw: string | null): { ok: true; scope: LessonListScope | null } | { ok: false; error: string } {
  if (raw === null || raw.trim() === "") return { ok: true, scope: null };
  const v = raw.trim();
  if (v === "team" || v === "mine" || v === "teammates") return { ok: true, scope: v };
  return { ok: false, error: "scope 는 team|mine|teammates 중 하나입니다." };
}

/** team·mine 목록 where 조각(teammates 는 teammateLessonWhere). mine 은 admin 이어도 본인 것만. */
export function lessonScopeWhere(
  scope: LessonListScope | null,
  viewer: Viewer,
): { userId: null } | { userId: string } | { id: { in: string[] } } | null {
  if (scope === "team") return { userId: null };
  if (scope === "mine") return viewer.personId ? { userId: viewer.personId } : { id: { in: [] } };
  return null;
}

/** 팀원 레슨 where — 활성 멤버(activeMemberIds) 중 나를 뺀 사람의 공개 개인 레슨(복사본 제외). admin 도 공개된 것만(스펙 §7). 사람 미상 = null. */
export function teammateLessonWhere(
  viewer: Viewer,
  activeMemberIds: string[],
): { userId: { in: string[] }; sharedWithTeam: true; copiedFromId: null } | null {
  if (!viewer.personId) return null;
  return { userId: { in: activeMemberIds.filter((id) => id !== viewer.personId) }, sharedWithTeam: true, copiedFromId: null };
}

/** 가져오기 판정 — 팀원 탭에 보이는 것만 가져온다. not_found = 404(남의 비공개·작성자 비활성·복사본 — 존재를 알리지 않는다), own·team = 400. */
export function copyDecision(
  lesson: { userId?: string | null; sharedWithTeam?: boolean | null; copiedFromId?: string | null },
  viewer: Viewer,
  authorActive: boolean,
): "ok" | "not_found" | "own" | "team" {
  if (!lesson.userId) return "team";
  if (!viewer.personId) return "not_found";
  if (lesson.userId === viewer.personId) return "own";
  if (!lesson.sharedWithTeam || !authorActive || lesson.copiedFromId) return "not_found";
  return "ok";
}

/** sharedWithTeam 변경 — 주인만(admin 도 남의 것은 못 바꾼다). */
export function canSetSharedWithTeam(lesson: { userId?: string | null }, viewer: Viewer): boolean {
  return !!lesson.userId && !!viewer.personId && lesson.userId === viewer.personId;
}

/** 팀 레슨으로 올리기 — admin 전용, 개인 레슨만. */
export function promoteDecision(lesson: { userId?: string | null }, viewer: Viewer): "ok" | "forbidden" | "not_personal" {
  if (viewer.role !== "admin") return "forbidden";
  if (!lesson.userId) return "not_personal";
  return "ok";
}
