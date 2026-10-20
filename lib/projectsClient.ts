/**
 * `/api/projects?archived=all&fields=sidebar` 요청 공유 — 사이드바와 브레드크럼이 문서를 열 때마다 같은 목록을 각자 받던 것을
 * 진행 중 요청 합치기 + 5초 캐시 + 서버 시드로 줄인다(lib/pagesClient 와 같은 규칙).
 * (ws) 레이아웃이 사이드바용으로 이미 읽은 프로젝트(보관 포함·접근 필터 동일)를 심으면 첫 로드는 네트워크 0회다.
 * 서버에서 import 돼도 안전하다 — window 가 없으면 시드·이벤트 등록을 건너뛴다.
 */
export type ClientProject = { id: string; name: string; archived: boolean };

const TTL_MS = 5000;
let cache: { at: number; projects: ClientProject[] } | null = null;
let inflight: Promise<ClientProject[] | null> | null = null;
/** inflight 가 fresh 호출로 시작됐는가 — 그 이전에 시작된 일반 요청을 fresh 가 재사용하면 낡은 목록을 받는다. */
let inflightFresh = false;
let invalidatedAt = 0;

function startFetch(fresh: boolean): Promise<ClientProject[] | null> {
  const p: Promise<ClientProject[] | null> = (async () => {
    try {
      const res = await fetch("/api/projects?archived=all&fields=sidebar", { cache: "no-store" }); // 지표 없는 가벼운 경로
      if (!res.ok) return null;
      const body = (await res.json()) as { projects: { id: string; name: string; archivedAt?: string | null }[] };
      return body.projects.map(({ id, name, archivedAt }) => ({ id, name, archived: archivedAt != null }));
    } catch {
      return null;
    }
  })().then((projects) => {
    if (inflight === p) {
      inflight = null;
      inflightFresh = false;
      if (projects) cache = { at: Date.now(), projects };
    }
    return projects;
  });
  inflight = p;
  inflightFresh = fresh;
  return p;
}

/** 보관 포함 프로젝트 목록(접근 가능한 것만). 실패면 null. fresh 는 캐시를 건너뛴다(쓰기 직후용). */
export function getProjects(opts: { fresh?: boolean } = {}): Promise<ClientProject[] | null> {
  if (!opts.fresh && cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.projects);
  if (inflight && (!opts.fresh || inflightFresh)) return inflight;
  return startFetch(Boolean(opts.fresh));
}

/**
 * 서버(레이아웃)가 읽은 목록으로 캐시를 채운다. `at` 은 서버가 목록을 읽은 시각(ISO) — 규칙은 seedPages 와 같다:
 * 이 페이지 탐색 시작보다 이르게 잡지 않고, 더 새 캐시나 그 뒤의 무효화가 있으면 버린다.
 */
export function seedProjects(projects: { id: string; name: string; archived?: boolean }[], opts: { at?: string | number | Date | null } = {}): void {
  if (typeof window === "undefined") return;
  const now = Date.now();
  const parsed = opts.at == null ? NaN : new Date(opts.at).getTime();
  const origin = typeof performance !== "undefined" && Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : NaN;
  const at = Number.isFinite(parsed) && Number.isFinite(origin) ? Math.min(now, Math.max(parsed, origin)) : Number.isFinite(parsed) ? Math.min(parsed, now) : now;
  if (at < invalidatedAt) return;
  if (cache && cache.at >= at) return;
  cache = { at, projects: projects.map(({ id, name, archived }) => ({ id, name, archived: Boolean(archived) })) };
}

export function invalidateProjects(): void {
  invalidatedAt = Date.now();
  cache = null;
  inflight = null;
  inflightFresh = false;
}

export function _resetProjectsClientForTests(): void {
  invalidateProjects();
  invalidatedAt = 0;
}

if (typeof window !== "undefined") {
  window.addEventListener("pages:changed", invalidateProjects);
}
