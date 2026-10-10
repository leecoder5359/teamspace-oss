/* 문서 목록 그룹핑 — 프로젝트별 / 폴더(최상위 조상)별 / 검색 중 평면. 순수 함수(테스트: lib/docsGroup.test.ts). */

export type GroupDoc = { id: string; title: string; parentId: string | null; projectId: string | null; updatedAt: string };
export type DocGroup<T> = { key: string; label: string | null; docs: T[] };

/** flat 모드 첫 표시 건수 */
export const DOCS_PAGE = 30;
/** 그룹당 첫 표시 건수 */
export const GROUP_PAGE = 10;

const UNCLASSIFIED_LABEL = "미분류";
const NO_FOLDER_LABEL = "폴더 없음";
const UNCLASSIFIED_KEY = "__unclassified__";
const NO_FOLDER_KEY = "__nofolder__";

const ts = (d: GroupDoc) => {
  const n = Date.parse(d.updatedAt);
  return Number.isNaN(n) ? 0 : n;
};
const byUpdatedDesc = (a: GroupDoc, b: GroupDoc) => ts(b) - ts(a);

/** 그룹 순서: 그룹 내 최신 updatedAt desc, `last` 키는 맨 끝. */
function orderGroups<T extends GroupDoc>(groups: DocGroup<T>[], lastKey: string): DocGroup<T>[] {
  const newest = (g: DocGroup<T>) => (g.docs.length ? ts(g.docs[0]) : 0);
  return [...groups].sort((a, b) => {
    if (a.key === lastKey) return 1;
    if (b.key === lastKey) return -1;
    return newest(b) - newest(a);
  });
}

export function groupDocs<T extends GroupDoc>(
  docs: readonly T[],
  opts: { projectId: string; projects: readonly { id: string; name: string; archivedAt?: string | null }[]; query: string },
): { mode: "flat" | "byProject" | "byFolder"; groups: DocGroup<T>[] } {
  const sorted = [...docs].sort(byUpdatedDesc);

  if (opts.query.trim()) {
    return { mode: "flat", groups: [{ key: "all", label: null, docs: sorted }] };
  }

  if (!opts.projectId) {
    // 보관 프로젝트는 사이드바와 같이 `이름 (보관)` 으로 남긴다(미분류로 떨어뜨리지 않는다)
    const names = new Map(opts.projects.map((p) => [p.id, p.archivedAt ? `${p.name} (보관)` : p.name]));
    const buckets = new Map<string, DocGroup<T>>();
    for (const d of sorted) {
      // 알 수 없는 프로젝트 id 도 미분류로 모은다(이름을 못 붙인다)
      const known = d.projectId != null && names.has(d.projectId);
      const key = known ? (d.projectId as string) : UNCLASSIFIED_KEY;
      let g = buckets.get(key);
      if (!g) {
        g = { key, label: known ? (names.get(key) as string) : UNCLASSIFIED_LABEL, docs: [] };
        buckets.set(key, g);
      }
      g.docs.push(d);
    }
    return { mode: "byProject", groups: orderGroups([...buckets.values()], UNCLASSIFIED_KEY) };
  }

  // byFolder — 주어진 docs 안에서 parentId 를 따라 올라간 최상위 조상
  const byId = new Map(sorted.map((d) => [d.id, d]));
  const rootOf = (d: T): T => {
    let cur = d;
    const seen = new Set<string>([cur.id]);
    while (cur.parentId && byId.has(cur.parentId) && !seen.has(cur.parentId)) {
      cur = byId.get(cur.parentId) as T;
      seen.add(cur.id);
    }
    return cur;
  };
  const buckets = new Map<string, DocGroup<T>>();
  const rootDocs = new Map<string, T>();
  for (const d of sorted) {
    const root = rootOf(d);
    rootDocs.set(root.id, root);
    let g = buckets.get(root.id);
    if (!g) {
      g = { key: root.id, label: root.title || "제목 없음", docs: [] };
      buckets.set(root.id, g);
    }
    g.docs.push(d);
  }
  // 하위 문서가 없는 단독 문서는 폴더가 아니다 → "폴더 없음" 으로 모은다
  const loose: T[] = [];
  const groups: DocGroup<T>[] = [];
  for (const g of buckets.values()) {
    if (g.docs.length === 1) loose.push(g.docs[0]);
    else groups.push(g);
  }
  const ordered = orderGroups(groups, NO_FOLDER_KEY);
  if (loose.length) {
    loose.sort(byUpdatedDesc);
    ordered.push({ key: NO_FOLDER_KEY, label: NO_FOLDER_LABEL, docs: loose });
  }
  return { mode: "byFolder", groups: ordered };
}
