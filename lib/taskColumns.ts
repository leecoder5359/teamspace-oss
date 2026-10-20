/* =====================================================================
   보드 행의 비정규화 칸(감사 P-14) — 순수 계산만.
   DbRow.statusOptionId·assigneeText 는 props JSON 에서 뽑은 값이고, taskColsKey 는 그 값을 뽑을 때 쓴
   '상태 속성 id|담당자 속성 id' 다. 읽기 쪽(lib/taskRows)은 지금 속성으로 만든 키와 같은 행만 칸으로 거르고,
   키가 다르거나 없는 행(백필 전·속성 변경 뒤)은 예전처럼 props 를 읽어 JS 로 거른다 — 그 행들은 칸이 낡아도
   결과가 틀리지 않고 느려질 뿐이다. **키가 맞는데 칸만 낡은 행은 이 보장 밖이다**: 새 코드를 거치지 않은 props 쓰기
   (배포 롤백 구간의 옛 바이너리·수동 SQL·이 코드가 없는 사본)가 만든다. 그래서 props 를 쓰는 모든 경로는 같은 쓰기에서
   deriveTaskColumns 결과를 함께 쓰고, 배포마다 scripts/rederive-task-columns.ts(마이그레이션과 같은 SQL)가 전체를 다시 맞춘다.
   ===================================================================== */

import { findAssigneeProp, findStatusProp, type PropLite } from "@/lib/taskProps";

export type TaskColumns = { statusOptionId: string | null; assigneeText: string | null; taskColsKey: string };

/** 상태·담당자 속성 선택(lib/taskProps 휴리스틱) 결과를 키로. 속성 배열은 position 오름차순이어야 한다. */
export function taskColsKey(props: readonly PropLite[]): string {
  return deriveTaskColumns(props, {}).taskColsKey;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** 행 props → 비정규화 칸. 담당자는 tasks 라우트처럼 앞뒤 공백을 다듬고 빈 값은 null. */
export function deriveTaskColumns(props: readonly PropLite[], rowProps: Readonly<Record<string, unknown>>): TaskColumns {
  const statusProp = findStatusProp([...props]);
  const assigneeProp = findAssigneeProp([...props]);
  return {
    statusOptionId: statusProp ? str(rowProps[statusProp.id]) : null,
    assigneeText: assigneeProp ? str(rowProps[assigneeProp.id])?.trim() || null : null,
    taskColsKey: `${statusProp?.id ?? ""}|${assigneeProp?.id ?? ""}`,
  };
}

/** 닫힌 상태 옵션 id — '닫힘' 판정은 라우트마다 다르므로(tasks=이름 규칙, context=마지막 옵션) 함수로 받는다. */
export function closedOptionIds(statusProp: PropLite | null, isClosed: (name: string) => boolean): string[] {
  return (statusProp?.config?.options ?? []).filter((o) => isClosed(o.name)).map((o) => o.id);
}
