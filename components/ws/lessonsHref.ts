/** /lessons 링크 — 문서 허브가 LessonsPage 화면 전체를 끌어오지 않게 따로 둔다(감사 P-5). */
export function lessonsHref(project?: string | null): string {
  return project && project !== "__none__" ? `/lessons?project=${encodeURIComponent(project)}` : "/lessons";
}
