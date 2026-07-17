/* 문서함 목록 필터 — 제목 검색 + 프로젝트. 순수 함수(테스트: lib/docFilter.test.ts). */

export type DocFilterItem = { title: string; projectId?: string | null };

/** 프로젝트 필터 sentinel: 미분류(프로젝트 없는 문서)만 보기. */
export const NO_PROJECT = "__none__";

export function filterDocs<T extends DocFilterItem>(
  docs: T[],
  opts: { query?: string; projectId?: string | null },
): T[] {
  const q = (opts.query ?? "").trim().toLowerCase();
  const pid = opts.projectId ?? "";

  return docs.filter((d) => {
    if (q && !d.title.toLowerCase().includes(q)) return false;
    if (pid === NO_PROJECT) return d.projectId == null;
    if (pid && d.projectId !== pid) return false;
    return true;
  });
}
