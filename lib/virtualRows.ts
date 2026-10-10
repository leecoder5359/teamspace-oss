/**
 * 보드 표 뷰 가상 스크롤의 순수 계산(P-1).
 *
 * 1,230행 보드를 통째로 그리면 DOM 이 수만 노드가 된다. 행 높이가 거의 일정하다는 점을
 * 이용해 "보이는 창 + 위아래 여유(overscan)" 만 그리고, 안 그린 행은 위·아래 스페이서
 * 행의 높이로 대신한다. 의존성 없이 직접 구현한다.
 */

/** 이 수 이하 행은 종전처럼 전부 렌더한다. */
export const VIRTUAL_THRESHOLD = 150;
/** 첫 행을 재기 전 추정 행 높이(px). */
export const DEFAULT_ROW_HEIGHT = 40;

/** 가상 스크롤 해제 플래그 키(localStorage) — 값 "0" 이면 끈다. */
export const VIRTUAL_FLAG_KEY = "ws-table-virtual";

/**
 * 가상 스크롤을 끌지(P-1 한계 탈출구). 창 밖 행은 DOM 에 없어서 브라우저 찾기(Ctrl+F)·Tab 이 못 닿는다 —
 * `?virtual=0` 또는 localStorage `ws-table-virtual=0` 이면 행을 전부 그린다.
 * 저장소 접근이 막힌 환경(사생활 모드 등)에서도 throw 하지 않는다.
 */
export function virtualDisabled(search: string, storage: Pick<Storage, "getItem"> | null | undefined): boolean {
  try {
    if (new URLSearchParams(search).get("virtual") === "0") return true;
  } catch {}
  try {
    return storage?.getItem(VIRTUAL_FLAG_KEY) === "0";
  } catch {
    return false;
  }
}
const DEFAULT_OVERSCAN = 10;

/**
 * 스크롤 위치에서 그릴 행 범위를 구한다.
 * - scrollTop·viewportHeight 는 스크롤 부모 기준, offsetTop 은 tbody 가 스크롤 부모 콘텐츠 안에서 시작하는 y.
 * - end 는 exclusive. 패딩 = 안 그린 행 수 × rowHeight.
 */
export function windowRange(args: {
  scrollTop: number;
  viewportHeight: number;
  offsetTop: number;
  rowHeight: number;
  total: number;
  overscan?: number;
}): { start: number; end: number; topPad: number; bottomPad: number } {
  const total = Math.max(0, Math.floor(args.total));
  const rh = Number.isFinite(args.rowHeight) && args.rowHeight > 0 ? args.rowHeight : DEFAULT_ROW_HEIGHT;
  const overscan = Math.max(0, Math.floor(args.overscan ?? DEFAULT_OVERSCAN));
  const vh = Math.max(0, args.viewportHeight || 0);
  const rel = (args.scrollTop || 0) - (args.offsetTop || 0);

  const clamp = (n: number) => Math.min(total, Math.max(0, n));
  const first = clamp(Math.floor(rel / rh));
  const last = Math.max(first, clamp(Math.ceil((rel + vh) / rh)));
  const start = Math.max(0, first - overscan);
  const end = Math.min(total, last + overscan);
  return { start, end, topPad: start * rh, bottomPad: (total - end) * rh };
}

const SCROLLABLE = /^(auto|scroll|overlay)$/;

/** 세로로 실제 넘치는가 — 1px 이하 차이는 소수점 반올림 잡음으로 보고 무시한다. */
export function scrollsY(el: HTMLElement): boolean {
  return el.scrollHeight - el.clientHeight > 1;
}

/**
 * 세로로 스크롤되는 가장 가까운 조상, 없으면 window.
 *
 * 계산값 overflow-y 만 보면 안 된다: `.ws-table-wrap` 처럼 overflow-x:auto 만 준 요소도
 * CSS 규칙상 overflow-y 계산값이 auto 가 된다(한 축이 visible 이 아니면 다른 축도 auto).
 * 그래서 실제로 세로로 넘치는 조상만 스크롤 부모로 본다. 소수점 행 높이 때문에 안 넘치는
 * 요소가 scrollHeight = clientHeight + 1 로 보고되기도 해서 1px 여유를 둔다(scrollsY).
 * 브라우저 전용(effect·이벤트 콜백 안에서만 부른다).
 */
export function findScrollParent(el: HTMLElement | null): HTMLElement | Window {
  let node = el?.parentElement ?? null;
  while (node && node !== document.body && node !== document.documentElement) {
    const oy = window.getComputedStyle(node).overflowY;
    if (SCROLLABLE.test(oy) && scrollsY(node)) return node;
    node = node.parentElement;
  }
  return window;
}

export type VirtualSegment =
  | { kind: "pad"; key: string; height: number }
  | { kind: "rows"; from: number; to: number };

/**
 * 창 [start,end) 를 그릴 조각 목록으로 편다. pin(포커스가 든 행 인덱스)이 창 밖이면
 * 그 행 하나를 제자리에 따로 끼워 넣고 사이 스페이서를 나눈다 — 편집 중인 입력칸이
 * 스크롤로 언마운트되면 blur 저장 없이 값이 사라지기 때문(I3).
 * 높이 0 인 스페이서는 내지 않는다(마지막 행 테두리 규칙 유지).
 */
export function windowSegments(args: {
  start: number;
  end: number;
  total: number;
  rowHeight: number;
  pin?: number | null;
}): VirtualSegment[] {
  const { start, end, total } = args;
  const rh = Number.isFinite(args.rowHeight) && args.rowHeight > 0 ? args.rowHeight : DEFAULT_ROW_HEIGHT;
  const pin = args.pin;
  const out: VirtualSegment[] = [];
  const pad = (key: string, rows: number) => {
    if (rows > 0) out.push({ kind: "pad", key, height: rows * rh });
  };
  const rows = (from: number, to: number) => {
    if (to > from) out.push({ kind: "rows", from, to });
  };
  if (pin == null || !Number.isInteger(pin) || pin < 0 || pin >= total || (pin >= start && pin < end)) {
    pad("__vpad-top", start);
    rows(start, end);
    pad("__vpad-bottom", total - end);
  } else if (pin < start) {
    pad("__vpad-top", pin);
    rows(pin, pin + 1);
    pad("__vpad-mid", start - pin - 1);
    rows(start, end);
    pad("__vpad-bottom", total - end);
  } else {
    pad("__vpad-top", start);
    rows(start, end);
    pad("__vpad-mid", pin - end);
    rows(pin, pin + 1);
    pad("__vpad-bottom", total - pin - 1);
  }
  return out;
}
