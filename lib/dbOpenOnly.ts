// 표 뷰 "열린 것만" 토글의 순수 로직. isOpenStatus 는 taskFilter 것을 그대로 쓴다.
import { isOpenStatus } from "@/lib/taskFilter";

export type OpenOnlyProp = {
  id: string;
  name: string;
  type: string;
  config: { options?: { id: string; name: string }[] } | null;
};
export type OpenOnlyRow = { id?: string; props: Record<string, unknown>; updatedAt?: string };

/** select 타입이면서 이름이 status|상태 인 첫 속성. 없으면 null(토글 숨김). */
export function findStatusProp<P extends OpenOnlyProp>(props: P[]): P | null {
  return props.find((p) => p.type === "select" && /status|상태/i.test(p.name)) ?? null;
}

function statusName(row: OpenOnlyRow, prop: OpenOnlyProp): string | null {
  const v = row.props[prop.id];
  if (typeof v !== "string" || !v) return null;
  const opt = prop.config?.options?.find((o) => o.id === v);
  return opt ? opt.name : null; // 모르는 옵션은 null → 열림으로 취급
}

export function isRowOpen(row: OpenOnlyRow, statusProp: OpenOnlyProp | null): boolean {
  if (!statusProp) return true;
  return isOpenStatus(statusName(row, statusProp));
}

export function visibleRows<R extends OpenOnlyRow>(
  rows: R[],
  props: OpenOnlyProp[],
  opts: { openOnly: boolean },
): R[] {
  if (!opts.openOnly) return rows;
  const sp = findStatusProp(props);
  if (!sp) return rows;
  return rows.filter((r) => isRowOpen(r, sp));
}

export function hiddenCount(rows: OpenOnlyRow[], props: OpenOnlyProp[]): number {
  const sp = findStatusProp(props);
  if (!sp) return 0;
  return rows.filter((r) => !isRowOpen(r, sp)).length;
}

/** 수정 시각 내림차순 비교(없으면 맨 뒤). 동률은 호출 쪽이 position 으로 가른다. */
export function byUpdatedDesc(a: OpenOnlyRow, b: OpenOnlyRow): number {
  return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
}

export type OpenOnlyLayout<R> = {
  rows: R[];
  /** 최상위 행 순서 — buildRowTree 에 넘긴다. 없으면 position 순서 */
  rootCompare?: (a: R, b: R) => number;
  /** 닫힘 상태지만 방금 편집해서 남겨 둔 행 id — 흐리게 그린다 */
  kept: ReadonlySet<string>;
  /** 숨긴 완료·취소 행 수(남겨 둔 행 제외) */
  hidden: number;
};

const NONE: ReadonlySet<string> = new Set();

/**
 * 표에 넘길 행과 최상위 정렬. 열린 것만 ON + 뷰 정렬 없음이면 최상위 행을 updatedAt 내림차순으로 두되,
 * 서브아이템은 트리(부모 아래 position 순서)를 유지한다 — 종전엔 트리를 통째로 펴 버렸다(2A 후속).
 * keepIds: 이 화면에서 방금 편집한 행 — 완료로 바꿔도 바로 사라지지 않게 남긴다(필터를 바꾸면 비워진다).
 */
export function openOnlyLayout<R extends OpenOnlyRow>(
  rows: R[],
  props: OpenOnlyProp[],
  opts: { openOnly: boolean; hasViewSort: boolean; keepIds?: ReadonlySet<string> },
): OpenOnlyLayout<R> {
  const sp = opts.openOnly ? findStatusProp(props) : null;
  if (!sp) return { rows, kept: NONE, hidden: 0 };
  const kept = new Set<string>();
  let hidden = 0;
  const open = rows.filter((r) => {
    if (isRowOpen(r, sp)) return true;
    if (r.id && opts.keepIds?.has(r.id)) {
      kept.add(r.id);
      return true;
    }
    hidden++;
    return false;
  });
  return { rows: open, rootCompare: opts.hasViewSort ? undefined : byUpdatedDesc, kept, hidden };
}
