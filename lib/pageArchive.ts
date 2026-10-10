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

/**
 * 테스트에서 가짜를 넘길 수 있게 최소한으로 잡은 prisma 모양. 실제 prisma 의 오버로드 제네릭과
 * 맞추려 인자·반환을 느슨하게 둔다 — 이 모듈이 넘기는 where/select 는 아래 함수가 고정한다.
 */
export type PrismaLike = {
  page: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    count: (args: any) => PromiseLike<number>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany: (args: any) => PromiseLike<any[]>;
  };
};

/**
 * 워크스페이스의 보관 페이지 id 집합(조상 규칙). 즐겨찾기·최근·유사/개념 검색·ask·lint·지표·중복 제목이 쓴다.
 * 보관된 행이 하나도 없으면(대부분의 경우) 트리를 읽지 않는다.
 * 가시성은 거르지 않는다 — 호출 측이 visibleOnly/pageAccess 로 먼저 거른 뒤 이걸로 뺀다(D3: 보관 제외가 가시성을 넓히지 않게).
 */
export async function loadArchivedPageIds(db: PrismaLike, workspaceId: string): Promise<Set<string>> {
  const n = await db.page.count({ where: { workspaceId, deletedAt: null, archivedAt: { not: null } } });
  if (n === 0) return new Set();
  const pages: ArchiveNode[] = await db.page.findMany({
    where: { workspaceId, deletedAt: null },
    select: { id: true, parentId: true, archivedAt: true },
  });
  return archivedPageIds(pages);
}

/** 보관 집합에 든 행을 뺀다(순서 유지, 항상 새 배열). */
export function excludeArchived<T extends { id: string }>(rows: readonly T[], archived: ReadonlySet<string>): T[] {
  return archived.size === 0 ? [...rows] : rows.filter((r) => !archived.has(r.id));
}
