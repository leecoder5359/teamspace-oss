/**
 * 태스크 보드 속성 탐지 휴리스틱 (W5, 순수 로직).
 * tasks/context 라우트에 흩어져 있던 규칙을 한 곳으로: 이름/타입 기반으로
 * 제목·상태·담당자·마감일 속성을 찾는다(보드마다 id 가 달라서 이름으로 매핑).
 */

export type PropLite = {
  id: string;
  name: string;
  type: string;
  config?: { options?: { id: string; name: string }[] } | null;
};

export function findTitleProp(props: PropLite[]): PropLite | null {
  return props.find((p) => p.type === "text") ?? props[0] ?? null;
}

export function findStatusProp(props: PropLite[]): PropLite | null {
  return (
    props.find((p) => p.type === "select" && /status|상태/i.test(p.name)) ??
    props.find((p) => p.type === "select") ??
    null
  );
}

export function findAssigneeProp(props: PropLite[]): PropLite | null {
  return props.find((p) => (p.type === "text" || p.type === "person") && /담당|assignee|owner/i.test(p.name)) ?? null;
}

export function findDateProp(props: PropLite[]): PropLite | null {
  return props.find((p) => p.type === "date") ?? null;
}

/** select 속성에서 이름으로 옵션 id 찾기 (부분 일치 아님, 정확 일치 우선 → 시작 일치). */
export function optionIdByName(prop: PropLite | null, name: string): string | null {
  const options = prop?.config?.options ?? [];
  const exact = options.find((o) => o.name === name);
  if (exact) return exact.id;
  const starts = options.find((o) => o.name.startsWith(name));
  return starts?.id ?? null;
}
