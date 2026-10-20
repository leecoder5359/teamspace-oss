/* =====================================================================
   열린 태스크 행 읽기·칸 쓰기(감사 P-14) — 보드 행 전체(props JSON)를 읽어 JS 로 거르던 것을 DB 로.
   키(taskColsKey)가 지금 속성과 같은 행은 비정규화 칸으로 DB 에서 거르고, 다른 행(백필 전·속성 변경 뒤)만
   예전처럼 통째로 읽는다. 호출자는 받은 행에 기존 JS 필터를 그대로 건다 — 빠른 행엔 같은 결과라 무해하고,
   낡은 행은 그 필터가 정확하게 거른다. 계산은 lib/taskColumns(순수).
   ===================================================================== */

import type { Prisma } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import type { PropLite } from "@/lib/taskProps";
import { deriveTaskColumns, taskColsKey, type TaskColumns } from "@/lib/taskColumns";

/** 보드 속성 읽기 순서 — 상태·담당자 속성 선택(휴리스틱)이 순서에 달려 있어 쓰는 쪽·읽는 쪽·백필 SQL 이 같은 순서(position, id)를 쓴다.
 *  다르면 position 동률 보드에서 키가 어긋나 늘 느린 경로를 탄다(리뷰 M-1). */
export const taskPropOrder = (): Prisma.DbPropertyOrderByWithRelationInput[] => [{ position: "asc" }, { id: "asc" }];

export type TaskRowFilter = { closedOptionIds?: readonly string[]; assignee?: string | null };

/** 빠른·낡은 쿼리의 where(순수). 거를 것이 없으면 null. */
export function taskRowQueries(
  databasePageId: string,
  key: string,
  filter: TaskRowFilter,
): { fast: Prisma.DbRowWhereInput; stale: Prisma.DbRowWhereInput } | null {
  const closed = filter.closedOptionIds ?? [];
  const assignee = filter.assignee || null;
  if (!closed.length && !assignee) return null;
  return {
    fast: {
      databasePageId,
      taskColsKey: key,
      ...(closed.length ? { OR: [{ statusOptionId: null }, { statusOptionId: { notIn: [...closed] } }] } : {}),
      ...(assignee ? { assigneeText: assignee } : {}),
    },
    stale: { databasePageId, OR: [{ taskColsKey: null }, { taskColsKey: { not: key } }] },
  };
}

/** 두 position 오름차순 목록을 하나로(같은 position 이면 앞 목록 먼저). */
function mergeByPosition<T extends { position: number }>(a: readonly T[], b: readonly T[]): T[] {
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i].position <= b[j].position)) out.push(a[i++]);
    else out.push(b[j++]);
  }
  return out;
}

/** 보드의 후보 행(position 순). props 는 position 오름차순 보드 속성 — 키를 만들 때 쓴다. */
export async function findTaskRows(databasePageId: string, props: readonly PropLite[], filter: TaskRowFilter) {
  const orderBy = { position: "asc" } as const;
  const q = taskRowQueries(databasePageId, taskColsKey(props), filter);
  if (!q) return prisma.dbRow.findMany({ where: { databasePageId }, orderBy });
  const [fast, stale] = await Promise.all([
    prisma.dbRow.findMany({ where: q.fast, orderBy }),
    prisma.dbRow.findMany({ where: q.stale, orderBy }),
  ]);
  return mergeByPosition(fast, stale);
}

type PropReader = { dbProperty: { findMany: typeof prisma.dbProperty.findMany } };

/** 보드 속성을 읽어 행 props 의 비정규화 칸을 만든다 — 속성을 따로 읽지 않는 쓰기 경로용. 트랜잭션이면 tx 를 넘긴다. */
export async function taskColumnsForBoard(
  databasePageId: string,
  rowProps: Readonly<Record<string, unknown>>,
  db: PropReader = prisma,
): Promise<TaskColumns> {
  const props = await db.dbProperty.findMany({
    where: { databasePageId },
    orderBy: taskPropOrder(),
    select: { id: true, name: true, type: true, config: true },
  });
  return deriveTaskColumns(props.map((p) => ({ ...p, type: p.type as string, config: p.config as PropLite["config"] })), rowProps);
}
