// 사이드바 트리·그룹 순수 로직. React 없음.
import type { DocType } from "@/lib/docOrganize";

export type FlatPage = {
  id: string;
  title: string;
  icon: string | null;
  parentId: string | null;
  position: number;
  kind: "doc" | "database";
  projectId: string | null;
  docType?: DocType | null;
  childCount?: number;
  isFavorite?: boolean;
  /** D3 후속: 이 페이지가 모두에게 열려 있지 않다(조상·프로젝트 상속 포함) */
  restricted?: boolean;
  /** 잠금이 이 페이지에서 시작됐나 — 자손마다 자물쇠를 겹쳐 그리지 않으려고 */
  restrictedSelf?: boolean;
};
export type PageNode = FlatPage & { children: PageNode[] };
export type Group = { key: string; name: string; isProject: boolean; boards: FlatPage[]; roots: PageNode[] };
export const NONE = "__none__";
export const PAGE_LIMIT = 12;
export const TASK_NOTE_FOLDER = "태스크 설명";

export function buildTree(flat: readonly FlatPage[]): PageNode[] {
  const byId = new Map<string, PageNode>();
  for (const p of flat) byId.set(p.id, { ...p, children: [] });
  const roots: PageNode[] = [];
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) byId.get(node.parentId)!.children.push(node);
    else roots.push(node);
  }
  const sortRec = (nodes: PageNode[]): PageNode[] =>
    nodes.toSorted((a, b) => a.position - b.position).map((n) => ({ ...n, children: sortRec(n.children) }));
  return sortRec(roots);
}

export function groupByProject(flat: readonly FlatPage[], projects: readonly { id: string; name: string; archived?: boolean }[]): Group[] {
  const roots = buildTree(flat.filter((p) => p.kind === "doc"));
  const databases = flat.filter((p) => p.kind === "database");
  const key = (p: { projectId: string | null }) => p.projectId ?? NONE;
  const out: Group[] = projects.map((p) => ({
    key: p.id,
    name: p.archived ? `${p.name} (보관)` : p.name,
    isProject: true,
    boards: databases.filter((d) => key(d) === p.id),
    roots: roots.filter((r) => key(r) === p.id),
  }));
  const known = new Set(projects.map((p) => p.id));
  const nb = databases.filter((d) => !known.has(key(d)) || key(d) === NONE);
  const nr = roots.filter((r) => !known.has(key(r)) || key(r) === NONE);
  if (nb.length || nr.length) out.push({ key: NONE, name: "미분류", isProject: false, boards: nb, roots: nr });
  return out;
}

export function limitChildren<T>(items: readonly T[], expanded: boolean, limit = PAGE_LIMIT): { shown: T[]; hidden: number } {
  if (expanded || items.length <= limit) return { shown: [...items], hidden: 0 };
  return { shown: items.slice(0, limit), hidden: items.length - limit };
}

export function isTaskNoteFolder(node: PageNode): boolean {
  if (node.title === TASK_NOTE_FOLDER) return true;
  return node.children.length > 0 && node.children.every((c) => c.docType === "task_note");
}

/** 현재 프로젝트 외 전부 + 모든 '태스크 설명' 폴더 */
export function defaultCollapsed(groups: readonly Group[], activeProjectId: string | null): Set<string> {
  const out = new Set<string>();
  const walk = (nodes: readonly PageNode[]) => {
    for (const n of nodes) {
      if (isTaskNoteFolder(n)) out.add(n.id);
      walk(n.children);
    }
  };
  for (const g of groups) {
    if (g.key !== activeProjectId) out.add(g.key);
    walk(g.roots);
  }
  return out;
}

/** 모든 그룹의 '태스크 설명' 폴더 id(중첩 포함). */
export function taskNoteFolderIds(groups: readonly Group[]): string[] {
  const out: string[] = [];
  const walk = (nodes: readonly PageNode[]) => {
    for (const n of nodes) {
      if (isTaskNoteFolder(n)) out.push(n.id);
      walk(n.children);
    }
  };
  for (const g of groups) walk(g.roots);
  return out;
}

/**
 * 접힘 상태 결정. 저장값이 없으면 defaultCollapsed, 있으면 그대로 존중하되
 * 아직 본 적 없는 '태스크 설명' 폴더는 한 번 접어 둔다(이후 사용자가 펼치면 그 선택을 따른다).
 */
export function resolveCollapsed(
  saved: readonly string[] | null,
  seen: readonly string[] | null,
  groups: readonly Group[],
  activeProjectId: string | null,
): { collapsed: Set<string>; seen: string[] } {
  const collapsed = saved ? new Set(saved) : defaultCollapsed(groups, activeProjectId);
  const seenSet = new Set(seen ?? []);
  for (const id of taskNoteFolderIds(groups)) {
    if (!seenSet.has(id)) {
      collapsed.add(id);
      seenSet.add(id);
    }
  }
  return { collapsed, seen: [...seenSet] };
}
