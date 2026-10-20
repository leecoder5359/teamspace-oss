import type { HubEvent } from "./eventHub";

/*
 * SSE activity 를 보드별로 거르기(감사 P-8). 종전엔 워크스페이스 어디서든 활동 1건이면 열린 보드가
 * /api/databases/<id> 전체(~400KB)를 다시 받았다. 서버는 activity 에 targetId·boardId 를 싣고,
 * 보드는 자기와 닿는 이벤트에만 다시 읽는다.
 */

/** 보드 페이지 자체를 가리키는 활동 종류 — targetId 가 곧 보드(페이지) id. */
const PAGE_TARGETS = new Set(["board", "doc", "page"]);

/** 서버: activity 마다 boardId 를 붙인다. task 는 행 id → 보드 id(rowBoard), 보드 자체 활동은 targetId, 나머지는 null. */
export function attachBoardIds<T extends { targetType: string; targetId: string | null }>(
  acts: T[],
  rowBoard: ReadonlyMap<string, string>,
): (T & { boardId: string | null })[] {
  return acts.map((a) => ({
    ...a,
    boardId: !a.targetId ? null : a.targetType === "task" ? rowBoard.get(a.targetId) ?? null : a.targetType === "board" ? a.targetId : null,
  }));
}

/**
 * 클라: 이 보드가 다시 읽어야 하는 이벤트인가.
 * - 알림은 무시한다(같은 변경은 activity 로도 온다).
 * - task: boardId 가 이 보드·관계 대상 보드이거나, targetId 가 지금 보이는 행(다른 보드로 옮겨 간 행 포함)이면.
 *   id 를 모르면(구 서버라 boardId 필드가 없음·본문이 깨짐) 보수적으로 다시 읽는다 — 배포 순서가 어긋나도 갱신이 멈추지 않게.
 * - 보드 페이지 자체(이름 변경·삭제·복원·보관)는 targetId === 보드 id.
 * - 그 밖의 종류(문서·결정·승인…)는 보드 데이터를 바꾸지 않는다.
 */
export function boardEventMatches(
  ev: HubEvent,
  board: { id: string; rowIds: ReadonlySet<string>; relatedBoardIds: ReadonlySet<string> },
): boolean {
  if (ev.type !== "activity") return false;
  if (!ev.targetType) return true;
  if (ev.targetType === "task") {
    if (!ev.targetId || ev.boardId === undefined) return true;
    if (board.rowIds.has(ev.targetId)) return true;
    return !!ev.boardId && (ev.boardId === board.id || board.relatedBoardIds.has(ev.boardId));
  }
  return PAGE_TARGETS.has(ev.targetType) && ev.targetId === board.id;
}
