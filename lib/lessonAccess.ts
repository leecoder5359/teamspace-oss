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
