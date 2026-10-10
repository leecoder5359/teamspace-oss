/* 레슨 목록 질의 파라미터 — 순수 함수(라우트·MCP 가 같은 규칙을 쓰도록). */

export const LESSON_LIST_MAX_LIMIT = 300;
export const LESSON_LIST_DEFAULT_LIMIT = 100;

/** limit 문자열/숫자를 1..max 정수로 맞춘다. 비었거나 숫자가 아니면 null(= 상한 없음). */
export function clampLessonLimit(raw: string | number | null | undefined, max = LESSON_LIST_MAX_LIMIT): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

/** 검색어 정리 — 앞뒤 공백 제거, 비면 null. */
export function normalizeLessonQ(raw: string | null | undefined): string | null {
  const q = raw?.trim();
  return q ? q : null;
}

/** 제목 부분일치(대소문자 무시) — prisma where 조각. q 가 없으면 빈 객체. */
export function lessonTitleWhere(q: string | null): { title?: { contains: string; mode: "insensitive" } } {
  return q ? { title: { contains: q, mode: "insensitive" } } : {};
}

/** 메모리 목록용 같은 규칙(제목 부분일치·대소문자 무시) — 규칙 일치 검증용. */
export function filterLessonsByTitle<T extends { title: string }>(items: T[], q: string | null): T[] {
  if (!q) return items;
  const needle = q.toLowerCase();
  return items.filter((l) => l.title.toLowerCase().includes(needle));
}
