/* =====================================================================
   서버가 미리 읽어 넘긴 문서 본문(/p/[id] → PageView → 편집기).

   `GET /api/pages/<id>` 와 같은 모양({ page, markdown })에 렌더마다 새로 만드는 `nonce` 를 붙인다.
   편집기는 **처음 한 번만** 이 값을 쓰고 그 뒤로는 종전대로 API 에서 받는다:
   - 편집기/원문 모드를 바꿔 다시 마운트될 때 — 그 사이 저장으로 rev 가 올라갔을 수 있다
   - 뒤로 가기 등으로 라우터 캐시의 옛 RSC 페이로드가 다시 쓰일 때 — 같은 nonce 라 이미 쓴 값이다
   낡은 rev 로 시작하면 저장이 409(병합)로 빠지므로, 한 번 쓴 값은 다시 쓰지 않는 게 계약이다.
   ===================================================================== */

export type PagePrefetch = {
  page: { id: string; title: string; icon: string | null; parentId: string | null; kind: string; rev: number };
  markdown: string;
  nonce: string;
};

const taken = new Set<string>();

/** 아직 쓰지 않은 미리 읽기면 돌려주고 '썼다' 로 표시한다. 이미 썼거나 없으면 null(→ API fetch). */
export function takePrefetch(p: PagePrefetch | null | undefined): PagePrefetch | null {
  if (!p || taken.has(p.nonce)) return null;
  taken.add(p.nonce);
  return p;
}
