/* POST /api/rows/[id]/move 의 본체 — 행을 다른 보드로 옮긴다(T-3a, 라우트에서 순수 이동).
   라우트는 requireCtx 가드·본문 파싱(targetDatabaseId 필수)만 하고 여기로 넘긴다.
   원본/대상 보드 접근 게이트(requirePage·gatePage)는 행을 읽어야 알 수 있어 여기서 부르고, 그 응답은 passthrough.
   흐름: 행·대상 확인 → 낙관적 잠금 → 하위 항목 거부 → planRowMove → 끊긴 relation 정리 → (dryRun 이면 보고만)
   → 트랜잭션(옵션 생성 + CAS 이동) → 활동 기록. 실패는 serviceResult 유니온으로 돌려준다. */
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { Ctx } from "@/lib/workspace";
import { requirePage, gatePage, notFound as pageNotFound } from "@/lib/pageGuard";
import { validateRelationProps } from "@/lib/relationServer";
import { checkExpectedUpdatedAt } from "@/lib/concurrency";
import { normalizeIds } from "@/lib/relation";
import { recordActivity } from "@/lib/activity";
import { log } from "@/lib/log";
import { fail, passthrough, type ServiceFail, type ServicePassthrough } from "@/lib/serviceResult";
import {
  planRowMove,
  type CreatedOption,
  type DroppedProp,
  type MappedProp,
  type MoveOption,
  type MoveProp,
} from "@/lib/rowMove";

const propSelect = { id: true, name: true, type: true, config: true } as const;

type PropRow = { id: string; name: string; type: string; config: unknown };
const lite = (props: PropRow[]): MoveProp[] =>
  props.map((p) => ({ id: p.id, name: p.name, type: p.type, config: (p.config ?? null) as MoveProp["config"] }));

/**
 * 이 행을 relation 으로 가리키는 **다른** 행 수. 이동을 막지는 않지만, 옮기고 나면
 * 그 연결은 '원본 보드를 가리키는 relation 에 다른 보드의 행 id' 가 되어 화면에
 * "(삭제된 행)" 으로 보인다 — 그래서 미리 알려 준다.
 *
 * 주의: 이 수는 **워크스페이스 전체**를 훑는다(D3 접근 게이트를 거치지 않는다) —
 * 호출자가 볼 수 없는 보드의 행도 셈에 들어갈 수 있다. 페이지 접근 필터링이 아니라
 * "숫자 하나로 주의를 주는" 용도라 지금은 괜찮지만, 이 숫자로 어떤 행/보드인지
 * 목록을 보여주는 기능을 만들 때는 반드시 visibleOnly 류로 걸러야 한다.
 */
async function countReferencedBy(workspaceId: string, sourceBoardId: string, rowId: string): Promise<number> {
  const relProps = await prisma.dbProperty.findMany({
    where: { type: "relation", database: { workspaceId, deletedAt: null } },
    select: { id: true, databasePageId: true, config: true },
  });
  const pointing = relProps.filter(
    (p) => (p.config as { targetDatabaseId?: string } | null)?.targetDatabaseId === sourceBoardId,
  );
  if (pointing.length === 0) return 0;
  const byBoard = new Map<string, string[]>();
  for (const p of pointing) byBoard.set(p.databasePageId, [...(byBoard.get(p.databasePageId) ?? []), p.id]);
  const rows = await prisma.dbRow.findMany({
    where: { databasePageId: { in: [...byBoard.keys()] }, NOT: { id: rowId } },
    select: { databasePageId: true, props: true },
  });
  return rows.filter((r) => {
    const props = (r.props ?? {}) as Record<string, unknown>;
    return (byBoard.get(r.databasePageId) ?? []).some((pid) => normalizeIds(props[pid]).includes(rowId));
  }).length;
}

export type MoveRowInput = {
  targetId: string;
  dryRun: boolean;
  createMissingOptions: boolean;
  expectedUpdatedAt?: string;
};

type MoveReport = {
  mapped: MappedProp[];
  dropped: DroppedProp[];
  createdOptions: { property: string; option: MoveOption }[];
  referencedBy: number;
};

export type MoveRowResult =
  | ({ ok: true; dryRun: true } & MoveReport)
  | ({ ok: true; dryRun: false; row: { id: string; databasePageId: string } } & MoveReport)
  | ServiceFail<Record<string, unknown>>
  | ServicePassthrough;

export async function moveRow(guard: Ctx, id: string, input: MoveRowInput): Promise<MoveRowResult> {
  const { targetId, dryRun } = input;

  const row = await prisma.dbRow.findUnique({
    where: { id },
    include: {
      database: {
        select: { workspaceId: true, title: true, dbProperties: { select: propSelect, orderBy: { position: "asc" } } },
      },
    },
  });
  if (!row || row.database.workspaceId !== guard.workspaceId) {
    return fail(404, "Not found");
  }
  // D3: 원본 보드에서 빼는 것도, 대상 보드에 넣는 것도 편집이다 — 둘 다 edit 이어야 한다.
  const gate = await requirePage(guard, row.databasePageId, "edit");
  if ("err" in gate) return passthrough(gate.err);

  if (targetId === row.databasePageId) {
    return fail(400, "이미 이 보드에 있는 행입니다.");
  }
  // D3: 접근 게이트가 먼저다 — "볼 수 없는 페이지"는 "존재하지 않는 페이지"와
  // 구분되면 안 된다. 그래서 대상을 DB 에서 읽어 kind/삭제/워크스페이스를 따지기
  // *전에* gatePage 로 먼저 막는다. 색인(gate.idx)은 원본 게이트에서 이미 만든
  // 것을 재사용한다(요청당 한 번).
  const tgate = gatePage(gate.idx, targetId, "edit");
  if ("err" in tgate) return passthrough(tgate.err);

  const target = await prisma.page.findUnique({
    where: { id: targetId },
    select: {
      id: true,
      kind: true,
      title: true,
      workspaceId: true,
      deletedAt: true,
      dbProperties: { select: propSelect, orderBy: { position: "asc" } },
    },
  });
  // 게이트는 통과했지만(색인에 있고 접근 가능) 실제로는 못 쓸 대상인 경우
  // (없음/다른 워크스페이스/보드 아님/삭제됨) — 이 넷을 서로도, 위 게이트 거부와도
  // 구분되지 않게 **같은 404 응답**으로 통일한다. 여기서 사유를 나눠 응답하면
  // "존재는 하는데 보드가 아니다" 같은 정보가 새어나간다. 서버 로그로만 구분한다.
  if (!target || target.kind !== "database" || target.workspaceId !== guard.workspaceId || target.deletedAt) {
    if (process.env.NODE_ENV !== "production") {
      // lib/log 는 레벨 필터가 없다 — 종전처럼 production 에선 남기지 않는다.
      log.debug("rows.move_target_unusable", {
        msg: "대상 보드를 쓸 수 없습니다",
        targetId,
        exists: !!target,
        kind: target?.kind,
        deleted: !!target?.deletedAt,
        sameWorkspace: target?.workspaceId === guard.workspaceId,
      });
    }
    return passthrough(pageNotFound());
  }

  // 낙관적 잠금(PATCH 와 같은 계약): expectedUpdatedAt 불일치 → 409 + 현재 행
  const check = checkExpectedUpdatedAt(input.expectedUpdatedAt, row.updatedAt);
  if (!check.ok) {
    return fail(409, "다른 곳에서 먼저 수정되었습니다. 현재 상태를 확인하고 다시 시도하세요.", {
      conflict: true,
      currentUpdatedAt: check.currentUpdatedAt,
      row,
    });
  }

  // 서브아이템은 같은 보드 안의 관계라 부모만 옮기면 자식이 원본 보드에 고아로 남는다.
  const childCount = await prisma.dbRow.count({ where: { parentRowId: id } });
  if (childCount > 0) {
    return fail(409, "하위 항목이 있는 행은 옮길 수 없습니다. 하위 항목을 먼저 옮기거나 분리하세요.", { childCount });
  }

  const plan = planRowMove({
    source: lite(row.database.dbProperties),
    target: lite(target.dbProperties),
    props: (row.props ?? {}) as Record<string, unknown>,
    createMissingOptions: input.createMissingOptions,
    newId: randomUUID,
  });
  if (!plan.ok) {
    return fail(400, plan.error, { mapped: plan.mapped, dropped: plan.dropped });
  }
  const props = plan.props;
  const mapped: MappedProp[] = [...plan.mapped];
  const dropped: DroppedProp[] = [...plan.dropped];

  // relation 으로 남긴 id 가 대상 보드에 아직 실재하는지. 원본에 끊긴 id("(삭제된 행)")가 있어도
  // 이동 자체를 400 으로 막지는 않고, 그 id 만 버리고 보고한다.
  for (const tp of target.dbProperties) {
    if (tp.type !== "relation" || !(tp.id in props)) continue;
    const ids = normalizeIds(props[tp.id]);
    const relTarget = (tp.config as { targetDatabaseId?: string } | null)?.targetDatabaseId;
    const known = relTarget
      ? new Set(
          (await prisma.dbRow.findMany({ where: { databasePageId: relTarget, id: { in: ids } }, select: { id: true } })).map(
            (r) => r.id,
          ),
        )
      : new Set<string>();
    const gone = ids.filter((x) => !known.has(x));
    if (gone.length === 0) continue;
    dropped.push({ name: tp.name, type: tp.type, reason: "대상 보드에 없는 행 id 입니다(끊긴 연결)", value: gone });
    const keep = ids.filter((x) => known.has(x));
    if (keep.length) props[tp.id] = keep;
    else {
      delete props[tp.id];
      const i = mapped.findIndex((m) => (m.to ?? m.name) === tp.name && m.type === "relation");
      if (i >= 0) mapped.splice(i, 1);
    }
  }
  const rel = await validateRelationProps(targetId, props);
  if (!rel.ok) return passthrough(rel.err);

  const referencedBy = await countReferencedBy(guard.workspaceId, row.databasePageId, id);
  const report = {
    mapped,
    dropped,
    createdOptions: plan.createdOptions.map((c) => ({ property: c.property, option: c.option })),
    referencedBy,
  };
  if (dryRun) return { ok: true, dryRun: true, ...report };

  const last = await prisma.dbRow.findFirst({
    where: { databasePageId: targetId },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  const finalProps: Record<string, unknown> = { ...rel.props };

  // 계획은 읽은 시점의 행으로 세웠다. 그 사이 누가 행을 고쳤거나(props 를 옛 스냅샷으로 덮게 된다)
  // 먼저 옮겼거나 하위 항목을 붙였으면 CAS 가 0건 → 트랜잭션 롤백(옵션 생성 포함) → 409.
  const CONFLICT = Symbol("conflict");
  let updated: { id: string; databasePageId: string; createdOptions: CreatedOption[] };
  try {
    updated = await prisma.$transaction(async (tx) => {
      // 옵션 생성: 계획을 세운 뒤 누가 같은 이름의 옵션을 먼저 만들었으면 그 id 를 쓴다(중복 옵션 방지).
      // plan.createdOptions 는 "계획을 세운 시점" 의 예상일 뿐이다 — 실제로 무엇을 만들었는지는
      // 여기, 트랜잭션 안에서 다시 읽은 config 기준으로 판정해서 돌려준다(응답이 계획이 아니라
      // 실제 결과를 말해야 한다).
      const byProp = new Map<string, { property: string; option: MoveOption }[]>();
      for (const c of plan.createdOptions)
        byProp.set(c.propertyId, [...(byProp.get(c.propertyId) ?? []), { property: c.property, option: c.option }]);
      const actuallyCreated: CreatedOption[] = [];
      for (const [propId, opts] of byProp) {
        const fresh = await tx.dbProperty.findUnique({ where: { id: propId }, select: { config: true } });
        const config = (fresh?.config ?? {}) as { options?: MoveOption[] };
        const options = [...(config.options ?? [])];
        for (const { property, option: o } of opts) {
          const existing = options.find((x) => x.name === o.name);
          if (existing) {
            // 동시에 다른 요청이 먼저 같은 이름의 옵션을 만들었다 — 재사용만 하고, 만들었다고 보고하지 않는다.
            const v = finalProps[propId];
            finalProps[propId] = Array.isArray(v) ? v.map((x) => (x === o.id ? existing.id : x)) : v === o.id ? existing.id : v;
          } else {
            const created = { ...o, color: o.color ?? "gray" };
            options.push(created);
            actuallyCreated.push({ property, propertyId: propId, option: created });
          }
        }
        await tx.dbProperty.update({ where: { id: propId }, data: { config: { ...config, options } as object } });
      }
      const res = await tx.dbRow.updateMany({
        where: { id, databasePageId: row.databasePageId, updatedAt: row.updatedAt, subItems: { none: {} } },
        data: {
          databasePageId: targetId,
          props: finalProps as object,
          position: (last?.position ?? -1) + 1,
          parentRowId: null,
          updatedById: guard.userId,
        },
      });
      if (res.count !== 1) throw CONFLICT;
      return { id, databasePageId: targetId, createdOptions: actuallyCreated };
    });
  } catch (e) {
    if (e !== CONFLICT) throw e;
    const current = await prisma.dbRow.findUnique({ where: { id } });
    return fail(409, "옮기는 사이 행이 바뀌었습니다(수정·이동·하위 항목 추가). 현재 상태를 확인하고 다시 시도하세요.", {
      conflict: true,
      row: current,
    });
  }

  // 알림은 보내지 않는다: 이동은 '재배치' 지 상태·담당자 변경이 아니다. PATCH 처럼
  // notifyTaskStatus/notifyTaskAssigned 를 부르면 옵션 id 가 바뀐 것을 변경으로 오인해
  // 상태 변경·배정 알림이 가짜로 나간다. 활동 로그만 남긴다.
  const srcTitleProp = row.database.dbProperties.find((p) => p.type === "text");
  const title = srcTitleProp ? String((row.props as Record<string, unknown>)[srcTitleProp.id] ?? "(제목 없음)") : "(제목 없음)";
  recordActivity(guard, "moved", "task", `${title} → ${target.title}`, id);

  return {
    ok: true,
    dryRun: false,
    row: { id: updated.id, databasePageId: updated.databasePageId },
    ...report,
    // report.createdOptions 는 트랜잭션 전 계획이다 — 실제로 무엇이 만들어졌는지로 덮어쓴다
    // (동시 요청이 먼저 같은 이름 옵션을 만들었으면 이번 요청은 그걸 재사용만 했을 수 있다).
    createdOptions: updated.createdOptions.map((c) => ({ property: c.property, option: c.option })),
  };
}
