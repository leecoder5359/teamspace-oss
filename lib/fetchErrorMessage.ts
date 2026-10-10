/* 클라이언트 fetch 응답이 OK 가 아닐 때 화면에 보여 줄 한 줄 메시지(순수).
 * 429 는 미들웨어 레이트 리밋(middleware.ts) — Retry-After 헤더(초)를 우선, 없으면 본문 retryAfterSec. */

export function fetchErrorMessage(status: number, retryAfter: string | null, body?: unknown): string {
  if (status === 429) {
    const fromHeader = Number(retryAfter);
    const fromBody = (body as { retryAfterSec?: unknown } | null | undefined)?.retryAfterSec;
    const sec =
      Number.isFinite(fromHeader) && fromHeader > 0
        ? Math.ceil(fromHeader)
        : typeof fromBody === "number" && fromBody > 0
          ? Math.ceil(fromBody)
          : null;
    return sec ? `요청이 많아요. ${sec}초 뒤 다시 시도해 주세요.` : "요청이 많아요. 잠시 뒤 다시 시도해 주세요.";
  }
  return "결과를 가져오지 못했어요. 잠시 뒤 다시 시도해 주세요.";
}

/** res.ok 가 아니면 메시지, OK 면 null. 본문은 읽지 않는다(429 는 헤더로 충분). */
export function responseErrorMessage(res: Response): string | null {
  if (res.ok) return null;
  return fetchErrorMessage(res.status, res.headers.get("retry-after"));
}
