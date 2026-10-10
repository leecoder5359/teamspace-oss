// 429 Retry-After 파싱 — CLI(ws.ts)·MCP 서버 공용. 초 단위 또는 HTTP-date, 최대 10초로 자른다.
export const MAX_RETRY_WAIT_MS = 10_000;

/** Retry-After 헤더 값 → 대기 ms(0..10000). 해석 불가·없음이면 null(재시도 안 함). */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  if (value == null) return null;
  const v = value.trim();
  if (!v) return null;
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(v)) ms = Number(v) * 1000;
  else {
    if (!/[A-Za-z]/.test(v)) return null; // 숫자만인 음수 등은 날짜로 보지 않는다
    const t = Date.parse(v);
    if (Number.isNaN(t)) return null;
    ms = t - now;
  }
  if (!Number.isFinite(ms)) return null;
  return Math.min(Math.max(Math.round(ms), 0), MAX_RETRY_WAIT_MS);
}

/** 대기 후 재시도해도 timeout 안에 끝날 여지가 있나. remaining 이 null 이면 제한 없음. */
export function shouldRetry(wait: number | null, remaining: number | null): boolean {
  if (wait == null) return false;
  if (remaining == null) return true;
  return wait < remaining - 500;
}

export interface RetryOpts {
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (wait: number) => void;
}

/**
 * fetch 를 한 번 호출하고, 429 + Retry-After 면 (남은 timeout 이 허락할 때만) 한 번 재시도한다.
 * 재시도에는 남은 시간만큼의 새 signal 을 쓴다. 반환 signal 은 본문 읽기에도 걸어야 한다.
 */
export async function fetchWithRetry(
  doFetch: (signal?: AbortSignal) => Promise<Response>,
  opts: RetryOpts = {},
): Promise<{ res: Response; signal?: AbortSignal }> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const start = now();
  const remaining = () => (opts.timeoutMs ? opts.timeoutMs - (now() - start) : null);
  let signal = opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined;
  let res = await doFetch(signal);
  if (res.status === 429) {
    const wait = parseRetryAfter(res.headers.get("retry-after"));
    if (wait != null && shouldRetry(wait, remaining())) {
      await res.body?.cancel().catch(() => {});
      opts.onRetry?.(wait);
      await sleep(wait);
      const left = remaining();
      signal = left != null ? AbortSignal.timeout(Math.max(left, 1)) : undefined;
      res = await doFetch(signal);
    }
  }
  return { res, signal };
}
