import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { requirePage, pageAccess } from "@/lib/pageGuard";
import { validateRelationProps } from "@/lib/relationServer";
import { wouldCycle } from "@/lib/subitems";
import { checkExpectedUpdatedAt } from "@/lib/concurrency";
import { notifyTaskAssigned, notifyTaskStatus } from "@/lib/notify";
import { findAssigneeProp, findTitleProp } from "@/lib/taskProps";
import { pushNotification, recordActivity, userIdsByNames } from "@/lib/activity";

// PATCH /api/rows/[id] → props 부분 갱신 + position 변경 + 문서 연결(contentPageId)
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const body = (await req.json().catch(() => ({}))) as {
    props?: Record<string, unknown>;
    position?: number;
    expectedUpdatedAt?: string;
    contentPageId?: string | null;
    /** 서브아이템(격차 C6): 같은 보드의 부모 행. null=최상위로 */
    parentRowId?: string | null;
  };
  const row = await prisma.dbRow.findUnique({
    where: { id },
    include: { database: { select: { workspaceId: true, dbProperties: { select: { id: true } } } } },
  });
  if (!row || row.database.workspaceId !== guard.workspaceId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // D3: 행은 보드(페이지)에 속한다 — 보드를 편집할 수 있어야 행을 건드린다.
  const gate = await requirePage(guard, row.databasePageId, "edit");
  if ("err" in gate) return gate.err;

  // props 의 키는 **이 행이 속한 보드의 속성**이어야 한다.
  //
  // 종전엔 검사가 없어, 다른 보드의 propId 를 보내면 그대로 병합돼 저장됐다.
  // 그 행의 보드는 그 propId 를 모르니 화면엔 아무 변화가 없고 응답은 200 이다
  // — 실사고가 있었다(2026-07-19 loyo: 기본 보드 propId 로 '완료' 처리됐는데
  // 실제 상태는 진행 중으로 남음). CLI 쪽만 고쳐 두었더니 같은 결함이 다른
  // 호출자(MCP·UI·직접 API)에 그대로 남아 있었다(전수조사 2026-08-07 P1).
  if (body.props) {
    const known = new Set(row.database.dbProperties.map((p) => p.id));
    const alien = Object.keys(body.props).filter((k) => !known.has(k));
    if (alien.length) {
      return NextResponse.json(
        {
          error: "이 행이 속한 보드의 속성이 아닙니다. 다른 보드의 속성 id 를 보냈는지 확인하세요.",
          unknownPropertyIds: alien,
          databasePageId: row.databasePageId,
        },
        { status: 400 },
      );
    }
  }

  // 낙관적 잠금(opt-in, 감사 task-2): expectedUpdatedAt 불일치 → 409 + 현재 행
  const check = checkExpectedUpdatedAt(body.expectedUpdatedAt, row.updatedAt);
  if (!check.ok) {
    return NextResponse.json(
      {
        error: "다른 곳에서 먼저 수정되었습니다. 현재 상태를 확인하고 다시 시도하세요.",
        conflict: true,
        currentUpdatedAt: check.currentUpdatedAt,
        row,
      },
      { status: 409 },
    );
  }

  // 문서 연결(W5 task-11): 같은 워크스페이스 페이지만, null=해제
  if (body.contentPageId !== undefined && body.contentPageId !== null) {
    const page = await prisma.page.findUnique({
      where: { id: body.contentPageId },
      select: { workspaceId: true, deletedAt: true },
    });
    if (!page || page.workspaceId !== guard.workspaceId || page.deletedAt) {
      return NextResponse.json({ error: "연결할 문서를 찾을 수 없습니다." }, { status: 400 });
    }
    // D3: 못 보는 문서를 태스크에 붙일 수 없다 — 붙는 순간 보드에서 제목이 보인다.
    if (pageAccess(gate.idx, body.contentPageId) === "none") {
      return NextResponse.json({ error: "연결할 문서를 찾을 수 없습니다." }, { status: 400 });
    }
    // DbRow.contentPageId 는 @unique 다 — 이미 다른 행에 붙은 문서를 연결하면
    // Prisma 가 P2002 를 던져 500 이 났다. 무엇이 잘못됐는지 알 수 없는 에러였다(D24).
    const taken = await prisma.dbRow.findFirst({
      where: { contentPageId: body.contentPageId, NOT: { id } },
      select: { id: true },
    });
    if (taken) {
      return NextResponse.json(
        { error: "이 문서는 이미 다른 태스크에 연결돼 있습니다.", conflictRowId: taken.id },
        { status: 409 },
      );
    }
  }

  // 서브아이템(C6): 같은 보드의 행이어야 하고, 순환을 만들면 안 된다.
  // 순환을 허용하면 표를 그리다 무한루프에 빠지고, 그걸 사용자가 만들 수 있게 두면 안 된다.
  if (body.parentRowId !== undefined && body.parentRowId !== null) {
    const parentId = body.parentRowId.trim();
    if (!parentId) return NextResponse.json({ error: "parentRowId 가 비어 있습니다." }, { status: 400 });
    const parent = await prisma.dbRow.findUnique({ where: { id: parentId }, select: { databasePageId: true } });
    if (!parent || parent.databasePageId !== row.databasePageId) {
      return NextResponse.json({ error: "부모 행은 같은 보드에 있어야 합니다." }, { status: 400 });
    }
    const siblings = await prisma.dbRow.findMany({
      where: { databasePageId: row.databasePageId },
      select: { id: true, parentRowId: true },
    });
    if (wouldCycle(id, parentId, new Map(siblings.map((r) => [r.id, r.parentRowId])))) {
      return NextResponse.json(
        { error: "자기 자신이나 자기 하위 항목을 부모로 지정할 수 없습니다.", parentRowId: parentId },
        { status: 400 },
      );
    }
  }

  const oldProps = row.props as Record<string, unknown>;
  let incoming = body.props;
  if (incoming) {
    // C2: relation 값 검증·정규화. 여기서 막지 않으면 화면에 "(삭제된 행)" 이 영원히 남는다.
    const rel = await validateRelationProps(row.databasePageId, incoming);
    if (!rel.ok) return rel.err;
    incoming = rel.props;
  }
  const mergedProps = incoming ? { ...oldProps, ...incoming } : oldProps;

  const updated = await prisma.dbRow.update({
    where: { id },
    data: {
      props: mergedProps as object,
      ...(body.position !== undefined ? { position: body.position } : {}),
      ...(body.contentPageId !== undefined ? { contentPageId: body.contentPageId } : {}),
      ...(body.parentRowId !== undefined ? { parentRowId: body.parentRowId?.trim() || null } : {}),
      updatedById: guard.userId, // 변경 액터 기록 (W5 task-13)
    },
  });
  if (incoming) {
    void notifyTaskStatus(row.databasePageId, oldProps, mergedProps);
    // 담당자 변경 알림 (W5 task-5 + W6 인앱 인박스)
    const props = await prisma.dbProperty.findMany({ where: { databasePageId: row.databasePageId } });
    const lite = props.map((p) => ({ id: p.id, name: p.name, type: p.type as string, config: p.config as { options?: { id: string; name: string }[] } }));
    const ap = findAssigneeProp(lite);
    const tp = findTitleProp(lite);
    const title = tp ? String(mergedProps[tp.id] ?? "(제목 없음)") : "(제목 없음)";
    if (ap && incoming[ap.id] !== undefined) {
      const oldA = (oldProps[ap.id] as string | undefined)?.trim() || null;
      const newA = (mergedProps[ap.id] as string | undefined)?.trim() || "";
      if (newA && newA !== oldA) {
        void notifyTaskAssigned(row.databasePageId, id, newA, oldA);
        void userIdsByNames(guard.workspaceId, [newA]).then((ids) =>
          pushNotification(guard.workspaceId, ids, "assigned", `👤 태스크 배정: ${title}`, `/p/${row.databasePageId}`, guard.userId),
        );
      }
    }
    recordActivity(guard, "updated", "task", title, id);
  }
  return NextResponse.json({ row: updated });
}

// DELETE /api/rows/[id]
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const row = await prisma.dbRow.findUnique({
    where: { id },
    include: { database: { select: { workspaceId: true } } },
  });
  if (!row || row.database.workspaceId !== guard.workspaceId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // D3: 행은 보드(페이지)에 속한다 — 보드를 편집할 수 있어야 행을 건드린다.
  const gate = await requirePage(guard, row.databasePageId, "edit");
  if ("err" in gate) return gate.err;
  await prisma.dbRow.delete({ where: { id } }).catch(() => {});
  return NextResponse.json({ ok: true });
}
