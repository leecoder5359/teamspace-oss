import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
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
  };
  const row = await prisma.dbRow.findUnique({
    where: { id },
    include: { database: { select: { workspaceId: true } } },
  });
  if (!row || row.database.workspaceId !== guard.workspaceId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
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
  }

  const oldProps = row.props as Record<string, unknown>;
  const mergedProps = body.props ? { ...oldProps, ...body.props } : oldProps;

  const updated = await prisma.dbRow.update({
    where: { id },
    data: {
      props: mergedProps as object,
      ...(body.position !== undefined ? { position: body.position } : {}),
      ...(body.contentPageId !== undefined ? { contentPageId: body.contentPageId } : {}),
      updatedById: guard.userId, // 변경 액터 기록 (W5 task-13)
    },
  });
  if (body.props) {
    void notifyTaskStatus(row.databasePageId, oldProps, mergedProps);
    // 담당자 변경 알림 (W5 task-5 + W6 인앱 인박스)
    const props = await prisma.dbProperty.findMany({ where: { databasePageId: row.databasePageId } });
    const lite = props.map((p) => ({ id: p.id, name: p.name, type: p.type as string, config: p.config as { options?: { id: string; name: string }[] } }));
    const ap = findAssigneeProp(lite);
    const tp = findTitleProp(lite);
    const title = tp ? String(mergedProps[tp.id] ?? "(제목 없음)") : "(제목 없음)";
    if (ap && body.props[ap.id] !== undefined) {
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
  await prisma.dbRow.delete({ where: { id } }).catch(() => {});
  return NextResponse.json({ ok: true });
}
