import type { prisma } from "@/lib/prisma";
import { loadArchivedPageIds, excludeArchived } from "@/lib/pageArchive";

/** 제목 비교용 정규화 — 공백 정리·NFC·소문자. */
export function normalizeTitle(t: string): string {
  return t.trim().replace(/\s+/g, " ").normalize("NFC").toLowerCase();
}

const PLACEHOLDERS = new Set(["", "untitled", "제목 없음", "new page"]);

/** 기본 제목(아직 이름 안 붙인 문서)은 중복으로 치지 않는다. */
export function isPlaceholderTitle(t: string): boolean {
  return PLACEHOLDERS.has(normalizeTitle(t));
}

/** 같은 (프로젝트, 정규화 제목) 문서끼리 서로의 id 를 매핑. 중복이 없는 문서는 키에 없다. */
export function findDuplicateTitles(
  pages: readonly { id: string; title: string; projectId: string | null; kind?: string }[],
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const p of pages) {
    if (p.kind !== undefined && p.kind !== "doc") continue;
    if (isPlaceholderTitle(p.title)) continue;
    const key = `${p.projectId ?? ""}\u0000${normalizeTitle(p.title)}`;
    const g = groups.get(key);
    if (g) g.push(p.id);
    else groups.set(key, [p.id]);
  }
  const out = new Map<string, string[]>();
  for (const ids of groups.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) out.set(id, ids.filter((x) => x !== id));
  }
  return out;
}

/**
 * 같은 워크스페이스·프로젝트의 같은 제목 문서를 찾는다. 목록 배지와 같은 normalizeTitle 로 JS 에서
 * 비교한다(DB insensitive 비교는 안쪽 공백·NFC 를 못 맞춘다). 후보는 take 500 으로 자른다 —
 * "프로젝트 없음" 버킷이 커도 터지지 않게. 호출 측이 가시성 필터 후 상한(10)을 적용한다.
 * 보관 문서(조상 규칙)는 중복으로 치지 않는다 — 보관된 '회의록'이 새 '회의록'을 막으면 안 된다.
 * 보관 집합은 같은 제목 후보가 있을 때만 읽는다.
 */
export async function findSameTitleDocs(
  db: Pick<typeof prisma, "page">,
  args: { workspaceId: string; projectId: string | null; title: string; excludeId?: string },
): Promise<{ id: string; title: string }[]> {
  if (isPlaceholderTitle(args.title)) return [];
  const want = normalizeTitle(args.title);
  const rows = await db.page.findMany({
    where: {
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      kind: "doc",
      deletedAt: null,
      ...(args.excludeId ? { id: { not: args.excludeId } } : {}),
    },
    take: 500,
    select: { id: true, title: true },
  });
  const same = rows.filter((r) => normalizeTitle(r.title) === want);
  if (same.length === 0) return same;
  return excludeArchived(same, await loadArchivedPageIds(db, args.workspaceId));
}
