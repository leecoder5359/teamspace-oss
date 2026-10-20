import { classifyRoles, type RoleProp } from "./propRoles";

/*
 * 대시보드 통계 서버 집계(감사 P-8). 종전엔 대시보드가 통계 몇 개를 그리려고 보드 전체(/api/databases/<id>,
 * ~400KB)를 받아 화면에서 셌다. 같은 셈을 여기서 하고 숫자와 마감 목록만 보낸다.
 * 날짜(오늘·이번 주·지연) 계산만은 화면에 남긴다 — "오늘" 은 보는 사람의 로컬 날짜라 서버에서 세면
 * 자정 근처에 하루가 어긋난다. 그래서 열린 행의 마감 원문(dueOpen)을 넘긴다.
 */

type Option = { id: string; name: string; color: string };
type StatProp = RoleProp & { config: unknown };
type StatRow = { id: string; props: unknown };

export type Bucket = Option & { count: number };

export type DashboardStats = {
  total: number;
  /** 상태 속성이 없으면 null. buckets 는 옵션 순서 그대로(0건 포함). */
  status: {
    buckets: Bucket[];
    /** 값이 비었거나 옵션에 없는 행 */
    unset: number;
    /** 이름 휴리스틱(진행·doing…) → 없으면 옵션이 3개 이상일 때 두 번째 */
    inProgress: { name: string; count: number } | null;
    /** 마지막 옵션 */
    done: { name: string; count: number } | null;
  } | null;
  /** 우선순위 → 심각도 → 첫 라벨 속성의 분포. 없으면 null. */
  second: { name: string; buckets: Bucket[] } | null;
  /** 담당자별 건수, 많은 순 상위 8 */
  assignees: { name: string; count: number }[];
  /** 마감 속성이 없으면 null. 완료가 아닌 행 중 마감 값이 있는 것(제목·첫 담당자 포함). */
  dueOpen: { id: string; title: string; due: string; assignee: string }[] | null;
};

function personNames(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  return value
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const optionsOf = (p: StatProp | undefined): Option[] =>
  ((p?.config as { options?: Option[] } | null)?.options ?? []).map(({ id, name, color }) => ({ id, name, color }));

export function buildDashboardStats(properties: readonly StatProp[], rows: readonly StatRow[]): DashboardStats {
  const { roles, titleId } = classifyRoles(properties);
  const byRole = (r: string) => properties.find((p) => roles.get(p.id) === r);
  const statusProp = byRole("status");
  const secondProp = byRole("priority") ?? byRole("severity") ?? byRole("label");
  const personProp = byRole("person");
  const dateProp = byRole("date");
  const titleProp = properties.find((p) => p.id === titleId) ?? properties[0];
  const propsOf = (r: StatRow) => (r.props ?? {}) as Record<string, unknown>;
  const countBy = (prop: StatProp, opts: Option[]): Bucket[] =>
    opts.map((o) => ({ ...o, count: rows.filter((r) => propsOf(r)[prop.id] === o.id).length }));

  const statusOptions = optionsOf(statusProp);
  const doneOpt = statusOptions[statusOptions.length - 1];
  const inProgressOpt =
    statusOptions.find((o) => /진행|doing|in.?progress|wip|작업/i.test(o.name)) ??
    (statusOptions.length > 2 ? statusOptions[1] : undefined);
  const statusBuckets = statusProp ? countBy(statusProp, statusOptions) : [];
  const countOf = (o: Option | undefined) => (o ? { name: o.name, count: statusBuckets.find((b) => b.id === o.id)?.count ?? 0 } : null);

  const assigneeMap = new Map<string, number>();
  if (personProp) {
    for (const r of rows) for (const name of personNames(propsOf(r)[personProp.id])) assigneeMap.set(name, (assigneeMap.get(name) ?? 0) + 1);
  }

  const isOpen = (r: StatRow) => !doneOpt || propsOf(r)[statusProp?.id ?? ""] !== doneOpt.id;

  return {
    total: rows.length,
    status: statusProp
      ? {
          buckets: statusBuckets,
          unset: rows.filter((r) => !statusOptions.some((o) => o.id === propsOf(r)[statusProp.id])).length,
          inProgress: countOf(inProgressOpt),
          done: countOf(doneOpt),
        }
      : null,
    second: secondProp ? { name: secondProp.name, buckets: countBy(secondProp, optionsOf(secondProp)) } : null,
    assignees: [...assigneeMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({ name, count })),
    dueOpen: dateProp
      ? rows.flatMap((r) => {
          const p = propsOf(r);
          const due = p[dateProp.id];
          if (typeof due !== "string" || !due || !isOpen(r)) return [];
          const title = titleProp ? p[titleProp.id] : "";
          return [{ id: r.id, title: typeof title === "string" ? title : "", due, assignee: personProp ? personNames(p[personProp.id])[0] ?? "" : "" }];
        })
      : null,
  };
}
