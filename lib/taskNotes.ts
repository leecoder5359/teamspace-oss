// 태스크 설명 문서([태스크 설명] …)는 목록·검색·세션 컨텍스트에서 기본 제외한다.
export const TASK_NOTE_EXCLUDE = { OR: [{ docType: null }, { docType: { not: "task_note" as const } }] };

// docType 이 있으면 그것을, 없으면(이관 전 데이터) 제목 접두어로 판정한다.
export function isTaskNote(p: { docType?: string | null; title: string }): boolean {
  if (p.docType) return p.docType === "task_note";
  return p.title.startsWith("[태스크 설명]");
}
