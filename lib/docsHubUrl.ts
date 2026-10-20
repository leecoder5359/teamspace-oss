/** 문서 허브(/docs)의 탭·선택 항목을 URL(?cat=&id=)로 주고받는다 — 새로고침·뒤로 가기·검색 결과 링크가 같은 화면에 떨어지게. */

export const DOCS_HUB_DEFAULT_CAT = "mddocs";

type Param = string | string[] | undefined;
const first = (v: Param) => (Array.isArray(v) ? v[0] : v) || null;

/** 탭 key·선택 id → 허브 주소. 기본 탭에 선택이 없으면 쿼리 없이 /docs. */
export function docsHubHref(cat: string, id: string | null): string {
  if (cat === DOCS_HUB_DEFAULT_CAT && !id) return "/docs";
  const sp = new URLSearchParams({ cat });
  if (id) sp.set("id", id);
  return `/docs?${sp.toString()}`;
}

/** 페이지 searchParams → 초기 탭·선택 id. 모르는 탭이면 기본 탭. */
export function parseDocsHubParams(
  params: { cat?: Param; id?: Param },
  validCats: readonly string[],
): { cat: string; id: string | null } {
  const cat = first(params.cat);
  return { cat: cat && validCats.includes(cat) ? cat : DOCS_HUB_DEFAULT_CAT, id: first(params.id) };
}
