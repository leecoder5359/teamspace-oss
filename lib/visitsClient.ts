/**
 * 방문 기록(POST /api/visits)과 '최근' 목록(GET /api/visits?limit=9)의 순서 맞추기.
 *
 * 문서를 처음 열면 사이드바가 최근 목록을 받고, 브레드크럼이 방문을 기록한 뒤 visits:changed 로 다시 받게 해서
 * GET·POST·GET 세 번이 나갔다. 첫 GET 은 방문 기록 전 스냅샷이라 어차피 버려진다.
 * - 목록 요청은 한 틱 기다렸다가(같은 커밋의 다른 effect 가 기록을 시작할 수 있게) 진행 중인 기록이 끝난 뒤에 보낸다.
 * - 같은 기록 상태(완료된 기록 수)에서 이미 나간 목록 요청이 있으면 그것을 같이 쓴다.
 * 그래서 첫 로드는 POST 1 + GET 1 이다. 기록은 여전히 열 때마다 정확히 한 번이다.
 */
export type VisitItem = { pageId: string; title: string; kind: "doc" | "database"; docType: string | null; projectId: string | null };

let pending: Promise<boolean> | null = null;
/** 끝난 기록 수 — 목록 요청이 어느 기록 상태를 반영하는지 표시한다. */
let settled = 0;
let listing: { seq: number; p: Promise<VisitItem[] | null> } | null = null;

/** 방문을 기록한다. 성공하면 visits:changed 를 쏜다(사이드바 '최근' 이 다시 읽는다). */
export function recordVisit(pageId: string): Promise<boolean> {
  const p: Promise<boolean> = fetch("/api/visits", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pageId }),
  })
    .then((r) => r.ok)
    .catch(() => false)
    .then((ok) => {
      settled++;
      if (pending === p) pending = null;
      return ok;
    });
  pending = p;
  void p.then((ok) => {
    if (ok && typeof window !== "undefined") window.dispatchEvent(new Event("visits:changed"));
  });
  return p;
}

/** 최근 방문 목록. 실패면 null. */
export async function getRecentVisits(): Promise<VisitItem[] | null> {
  await Promise.resolve();
  while (pending) await pending;
  if (listing && listing.seq === settled) return listing.p;
  const seq = settled;
  const p: Promise<VisitItem[] | null> = fetch("/api/visits?limit=9", { cache: "no-store" })
    .then(async (r) => (r.ok ? ((await r.json()) as { visits: VisitItem[] }).visits : null))
    .catch(() => null)
    .finally(() => {
      if (listing?.p === p) listing = null;
    });
  listing = { seq, p };
  return p;
}

export function _resetVisitsClientForTests(): void {
  pending = null;
  settled = 0;
  listing = null;
}
