/* =====================================================================
   프레즌스 (격차 D4) — 순수 함수.

   누가 이 문서를 보고 있는지 알 수 없어서, 같은 문서를 둘이 동시에 고치고
   나중에 저장 충돌(D1)로야 알아차렸다. 충돌을 **병합으로 수습**하는 것보다
   애초에 "지금 누가 여기 있다" 를 보여 주는 쪽이 싸다.

   저장은 **서버 메모리**다(DB 아님). 하트비트가 15초마다 오는 데이터를 영구
   저장할 이유가 없고, 프로세스가 재시작되면 어차피 다시 모인다. 대신 상한을
   두고 오래된 항목을 버린다 — 안 그러면 방문자 수만큼 무한히 쌓인다.
   ===================================================================== */

export type PresenceEntry = {
  userId: string;
  name: string;
  pageId: string;
  /** 마지막 하트비트(ms) */
  at: number;
  /** 보는 중이 아니라 고치는 중 */
  editing?: boolean;
};

/** 하트비트 하나를 반영한다(사람+페이지당 한 줄). */
export function touch(list: PresenceEntry[], entry: PresenceEntry): PresenceEntry[] {
  const i = list.findIndex((e) => e.userId === entry.userId && e.pageId === entry.pageId);
  if (i === -1) return [...list, entry];
  const next = [...list];
  next[i] = { ...next[i], ...entry };
  return next;
}

/**
 * 지금 이 페이지를 보고 있는 사람들. 편집 중인 사람을 앞에, 그다음 최근 순.
 * @param excludeUserId 자기 자신은 보통 뺀다(내가 여기 있는 건 나도 안다).
 */
export function viewersOf(
  list: PresenceEntry[],
  pageId: string,
  now: number,
  ttlMs: number,
  excludeUserId?: string,
): PresenceEntry[] {
  return list
    .filter((e) => e.pageId === pageId && now - e.at <= ttlMs && e.userId !== excludeUserId)
    .sort((a, b) => Number(!!b.editing) - Number(!!a.editing) || b.at - a.at);
}

/** 오래된 항목 버리기. TTL 의 두 배까지는 남겨 둔다(깜빡임 방지). */
export function pruneAll(list: PresenceEntry[], now: number, ttlMs: number): PresenceEntry[] {
  return list.filter((e) => now - e.at <= ttlMs * 2);
}

/** "가나, 다라 외 2명" */
export function summarize(names: string[], max = 3): string {
  if (names.length === 0) return "";
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} 외 ${rest}명` : shown.join(", ");
}
