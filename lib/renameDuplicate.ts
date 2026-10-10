import { findDuplicateTitles } from "@/lib/docTitles";
import { getPages } from "@/lib/pagesClient";

export const DUPLICATE_RENAME_NOTICE = "같은 프로젝트에 같은 제목 문서가 있어요";

/**
 * 이름을 바꾼 뒤, 그 문서가 같은 프로젝트의 다른 문서와 제목이 겹치는지(클라이언트 판정).
 * PATCH/PUT 응답은 경고를 싣지 않으므로 방금 갱신된 목록으로 목록 배지와 같은 규칙을 쓴다.
 * 목록 응답은 서버가 가시성을 이미 걸러 준 것이라 못 보는 문서 제목은 새지 않는다. 실패는 "겹침 없음".
 */
export async function renameCollides(pageId: string): Promise<boolean> {
  try {
    const r = await getPages({ fresh: true });
    if (!r.ok) return false;
    const pages = (r.data as { pages?: { id: string; title: string; projectId: string | null; kind?: string }[] } | null)?.pages ?? [];
    return findDuplicateTitles(pages).has(pageId);
  } catch {
    return false;
  }
}
