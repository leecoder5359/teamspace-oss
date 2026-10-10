// 태스크 목록 상한 — 한 번의 호출이 수만 토큰을 쏟지 않게 열린 것만·건수 제한.
// 실보드 상태 옵션(2026-10 조사): 할 일 / 진행 중 / 완료 — 아래 확장은 '끝남' 이 분명한 이름만.
// 보류·대기·검토·Blocked 는 아직 열린 일이라 넣지 않는다.
const CLOSED =
  /^(완료됨?|완료\s*처리|done|completed?|closed?|resolved|finished|종료|종결|취소됨?|canceled|cancelled|archived|won['’]?t\s*do|wontfix|won['’]?t\s*fix|abandoned|dropped|폐기)$/i;

export const DEFAULT_TASK_LIMIT = 50;
export const MAX_TASK_LIMIT = 200;

export function isOpenStatus(name: string | null): boolean {
  if (name == null) return true;
  return !CLOSED.test(name.trim());
}

/** CLI `--limit` 인자 → 1..200 정수(해석 불가는 기본 50). task ls/mine 공용. */
export function clampLimitArg(raw: string | undefined | null): number {
  return clampLimit(Math.floor(Number(raw)));
}

export function clampLimit(n: number | undefined | null): number {
  if (n == null || !Number.isFinite(n) || n <= 0) return DEFAULT_TASK_LIMIT;
  return Math.min(Math.floor(n), MAX_TASK_LIMIT);
}

/** total = 필터(status) 적용 후 전체 건수, shown = limit 로 자른 건수. */
export function applyTaskListFilter<T extends { status: string | null }>(
  rows: T[],
  opts: { status: "open" | "all"; limit?: number | "all" },
): { total: number; shown: number; tasks: T[] } {
  const filtered = opts.status === "all" ? rows : rows.filter((r) => isOpenStatus(r.status));
  // limit="all" 은 자사 UI(캘린더·관계 옵션) 전용 명시적 옵트인 — 에이전트 경로는 200 상한.
  const tasks = opts.limit === "all" ? filtered : filtered.slice(0, clampLimit(opts.limit));
  return { total: filtered.length, shown: tasks.length, tasks };
}
