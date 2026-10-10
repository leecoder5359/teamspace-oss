/**
 * 보관(F2)은 조상 기반이다 — 부모를 보관하면 하위 문서도 함께 숨겨지되, 자식 행에는 아무것도 쓰지 않는다.
 * (쓰기 전파를 하면 부모 보관 해제 때 '원래 따로 보관한' 자식과 구분할 수 없다.)
 * 사이드바 목록과 검색이 같은 규칙을 쓰도록 순수 함수로 둔다.
 */
export type ArchiveNode = { id: string; parentId: string | null; archivedAt: Date | null };

/** 스스로 보관됐거나 조상 중 하나가 보관된 페이지 id 집합. 순환 참조(데이터 오염)에도 멈춘다. */
export function archivedPageIds(pages: readonly ArchiveNode[]): Set<string> {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const memo = new Map<string, boolean>();
  const resolve = (start: string): boolean => {
    const trail: string[] = [];
    const seen = new Set<string>();
    let cur: string | null = start;
    let result = false;
    while (cur) {
      const known = memo.get(cur);
      if (known !== undefined) { result = known; break; }
      if (seen.has(cur)) break; // 순환 — 이 고리에서 보관 표식을 못 찾았으면 활성으로 본다
      seen.add(cur);
      trail.push(cur);
      const node = byId.get(cur);
      if (!node) break;
      if (node.archivedAt) { result = true; break; }
      cur = node.parentId;
    }
    // 보관 표식이 있으면 거기서 시작한 경로의 후손이 모두 true. 없으면 경로 전체가 false.
    for (const id of trail) memo.set(id, result);
    return result;
  };
  const out = new Set<string>();
  for (const p of pages) if (resolve(p.id)) out.add(p.id);
  return out;
}
