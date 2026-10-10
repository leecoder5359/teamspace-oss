/**
 * `/api/pages` 목록 요청 공유 (P-3/U7).
 * 사이드바·브레드크럼·문서·캘린더 등 11곳이 같은 목록을 각자 받던 것을
 * 진행 중 요청 합치기(dedupe) + 5초 캐시 + `pages:changed` 무효화로 줄인다.
 * 서버에서 import 돼도 안전하다 — window 가 없으면 이벤트 등록을 건너뛰고 fetch 만 한다.
 */
export type PagesResult = { ok: boolean; status: number; data: unknown | null };

const TTL_MS = 5000;
let cache: { at: number; result: PagesResult } | null = null;
let inflight: Promise<PagesResult> | null = null;
/** inflight 가 fresh 호출로 시작됐는가 — 쓰기 전에 시작된 일반 요청을 fresh 가 재사용하면 낡은 목록을 받는다. */
let inflightFresh = false;
/** 마지막 무효화 시각 — 그보다 먼저 찍힌 시드(서버 렌더 시점의 목록)는 이미 낡았다. */
let invalidatedAt = 0;

function startFetch(fresh: boolean): Promise<PagesResult> {
  const p: Promise<PagesResult> = (async () => {
    try {
      const res = await fetch("/api/pages", { cache: "no-store" });
      if (!res.ok) return { ok: false, status: res.status, data: null };
      return { ok: true, status: res.status, data: (await res.json()) as unknown };
    } catch {
      return { ok: false, status: 0, data: null };
    }
  })().then((result) => {
    // 진행 중 도중 invalidate 됐거나 더 새 요청으로 교체됐다면(inflight !== p) 낡은 결과는 캐시하지 않는다.
    if (inflight === p) {
      inflight = null;
      inflightFresh = false;
      if (result.ok) cache = { at: Date.now(), result };
    }
    return result;
  });
  inflight = p;
  inflightFresh = fresh;
  return p;
}

export function getPages(opts: { fresh?: boolean } = {}): Promise<PagesResult> {
  if (!opts.fresh && cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.result);
  // fresh 는 fresh 로 시작된 요청만 공유한다(그 이전에 시작된 일반 요청은 쓰기 전 스냅샷일 수 있다).
  if (inflight && (!opts.fresh || inflightFresh)) return inflight;
  return startFetch(Boolean(opts.fresh));
}

/** 캐시에 유효한 값이 있을 때만 동기로 돌려준다(첫 렌더 시드용). */
export function getPagesSync(): PagesResult | null {
  return cache && Date.now() - cache.at < TTL_MS ? cache.result : null;
}

/**
 * 서버(레이아웃)가 이미 준 목록으로 캐시를 채운다(U7) — 이어지는 `getPages({ fresh: false })` 는
 * 네트워크 없이 이 값을 받는다. 서버에서는 모듈 캐시가 요청 사이에 공유되므로 아무것도 하지 않는다.
 *
 * `at` 은 목록을 읽은 서버 시각(ISO)이다. 호출 시각으로 찍으면 SSR 부터 하이드레이션까지 걸린 시간만큼
 * 캐시가 더 오래 산다. 미래 값(서버 시계가 앞섬)·잘못된 값은 지금으로 자른다.
 * 그 시각보다 새 캐시가 있거나 그 뒤에 무효화가 있었다면 시드는 이미 낡았으므로 버린다 —
 * AppShell 과 사이드바가 같은 목록을 두 번 심어도 사이에 일어난 쓰기를 되돌리지 않는다.
 */
export function seedPages(data: unknown, opts: { at?: string | number | Date | null } = {}): void {
  if (typeof window === "undefined") return;
  const now = Date.now();
  const parsed = opts.at == null ? NaN : new Date(opts.at).getTime();
  // 서버 시계는 믿지 않는다: 클라이언트 시계가 앞서거나 하이드레이션이 늦어도 시드가 즉시 만료되지 않게,
  // 이 페이지의 탐색 시작(performance.timeOrigin) 아래로는 내려가지 않는다. performance 가 없으면 지금.
  const origin = typeof performance !== "undefined" && Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : NaN;
  const at = Number.isFinite(parsed) && Number.isFinite(origin) ? Math.min(now, Math.max(parsed, origin)) : Number.isFinite(parsed) ? Math.min(parsed, now) : now;
  if (at < invalidatedAt) return;
  if (cache && cache.at >= at) return;
  cache = { at, result: { ok: true, status: 200, data } };
}

export function invalidatePages(): void {
  invalidatedAt = Date.now();
  cache = null;
  inflight = null;
  inflightFresh = false;
}

export function _resetPagesClientForTests(): void {
  invalidatePages();
  invalidatedAt = 0;
}

if (typeof window !== "undefined") {
  window.addEventListener("pages:changed", invalidatePages);
}
