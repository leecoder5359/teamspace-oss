/** /api/pages 응답에 사이드바 트리용 메타(자식 수·내 즐겨찾기 여부)를 붙인다. 순수 함수. */
export function withTreeMeta<T extends { id: string; parentId: string | null }>(pages: T[], favoriteIds: Set<string>) {
  const counts = new Map<string, number>();
  for (const p of pages) if (p.parentId) counts.set(p.parentId, (counts.get(p.parentId) ?? 0) + 1);
  return pages.map((p) => ({ ...p, childCount: counts.get(p.id) ?? 0, isFavorite: favoriteIds.has(p.id) }));
}

/** 브레드크럼 경로: 프로젝트 › 폴더… › 문서. 순환(parentId 고리)은 끊는다. */
export function pathOf(
  pages: readonly { id: string; title: string; parentId: string | null; projectId: string | null }[],
  projects: readonly { id: string; name: string }[],
  pageId: string,
): { id: string | null; label: string; href: string }[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const chain: { id: string; title: string }[] = [];
  const seen = new Set<string>();
  let cur = byId.get(pageId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift({ id: cur.id, title: cur.title });
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  const projectId = byId.get(pageId)?.projectId ?? null;
  const project = projects.find((p) => p.id === projectId);
  return [
    { id: null, label: project?.name ?? "미분류", href: "/projects" },
    ...chain.map((c) => ({ id: c.id, label: c.title, href: `/p/${c.id}` })),
  ];
}
