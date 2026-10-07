/** 그래프 라벨 선택·축약 — 노드가 수백 개일 때 제목이 겹쳐 읽히지 않는 문제를 줄인다(순수 함수). */

export const LABEL_MAX_CHARS = 20;
export const LABEL_TOP_DEGREE = 15;
/** 보이는 폭이 전체 폭의 이 비율 이하(= 약 2.9배 이상 확대)면 모든 라벨을 그린다 */
export const LABEL_ZOOM_RATIO = 0.35;

export function truncateLabel(title: string, max = LABEL_MAX_CHARS): string {
  const chars = Array.from(title);
  return chars.length > max ? chars.slice(0, max).join("") + "…" : title;
}

export function isZoomedIn(visibleWidth: number, fullWidth: number): boolean {
  return visibleWidth <= fullWidth * LABEL_ZOOM_RATIO;
}

/** 호버 노드는 호출 쪽에서 따로 더한다(호버마다 재계산하지 않으려고). */
export function selectLabelIds(o: {
  nodes: { id: string; title?: string }[];
  deg: Map<string, number>;
  focus: string | null;
  visible: Set<string> | null;
  matches: Set<string> | null;
  zoomedIn: boolean;
}): Set<string> {
  if (o.zoomedIn) return new Set(o.nodes.map((n) => n.id));
  const ids = new Set<string>();
  [...o.nodes]
    .filter((n) => (o.deg.get(n.id) ?? 0) > 0) // 고립 노드는 허브가 아니다
    .sort(
      (a, b) =>
        (o.deg.get(b.id) ?? 0) - (o.deg.get(a.id) ?? 0) ||
        (a.title ?? "").localeCompare(b.title ?? "") ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .slice(0, LABEL_TOP_DEGREE)
    .forEach((n) => ids.add(n.id));
  if (o.focus) ids.add(o.focus);
  o.visible?.forEach((id) => ids.add(id));
  o.matches?.forEach((id) => ids.add(id));
  return ids;
}
