import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { requirePage } from "@/lib/pageGuard";
import { findAssigneeProp, findStatusProp, optionIdByName } from "@/lib/taskProps";
import { notifyTaskAssigned } from "@/lib/notify";
import { recordActivity } from "@/lib/activity";
import { findTitleProp } from "@/lib/taskProps";

export const runtime = "nodejs";

// POST /api/rows/[id]/claim [{ force?: true }] → 태스크 원자적 클레임 (W5 task-3).
// 담당자가 비어 있을 때만 담당자=현재 액터, 상태=진행 중 으로 설정한다.
// compare-and-swap(updatedAt 가드)이라 두 에이전트가 동시에 호출해도 한쪽만 성공,
// 진 쪽은 409 + 현재 담당자를 받는다. force=true 면 재할당(명시적 탈취)만 허용.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const body = (await req.json().catch(() => ({}))) as { force?: boolean };

  const row = await prisma.dbRow.findUnique({
    where: { id },
    include: { database: { select: { workspaceId: true, deletedAt: true } } },
  });
  if (!row || row.database.workspaceId !== guard.workspaceId || row.database.deletedAt) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const gate = await requirePage(guard, row.databasePageId, "edit");
  if ("err" in gate) return gate.err;

  const props = await prisma.dbProperty.findMany({
    where: { databasePageId: row.databasePageId },
    orderBy: { position: "asc" },
  });
  const propsLite = props.map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type as string,
    config: p.config as { options?: { id: string; name: string }[] },
  }));
  const assigneeProp = findAssigneeProp(propsLite);
  if (!assigneeProp) {
    return NextResponse.json({ error: "이 보드에는 담당자 속성이 없습니다." }, { status: 400 });
  }
  const statusProp = findStatusProp(propsLite);
  const inProgress = statusProp ? optionIdByName(statusProp, "진행 중") : null;

  const current = ((row.props as Record<string, unknown>)[assigneeProp.id] as string | undefined)?.trim();
  const me = guard.actor.name;
  if (current && !body.force) {
    if (current === me) return NextResponse.json({ ok: true, alreadyMine: true, assignee: current });
    return NextResponse.json(
      { error: `이미 ${current} 가 담당 중입니다.`, conflict: true, assignee: current },
      { status: 409 },
    );
  }

  const nextProps = {
    ...(row.props as Record<string, unknown>),
    [assigneeProp.id]: me,
    ...(statusProp && inProgress ? { [statusProp.id]: inProgress } : {}),
  };

  // CAS: 읽은 시점의 updatedAt 이 그대로일 때만 갱신 — 경쟁자가 먼저 잡았으면 count=0
  const res = await prisma.dbRow.updateMany({
    where: { id, updatedAt: row.updatedAt },
    data: { props: nextProps as object, updatedById: guard.userId },
  });
  if (res.count === 0) {
    const fresh = await prisma.dbRow.findUnique({ where: { id } });
    const now = fresh ? ((fresh.props as Record<string, unknown>)[assigneeProp.id] as string | undefined) : undefined;
    return NextResponse.json(
      { error: `동시에 다른 요청이 먼저 처리되었습니다${now ? ` (담당: ${now})` : ""}.`, conflict: true, assignee: now ?? null },
      { status: 409 },
    );
  }

  void notifyTaskAssigned(row.databasePageId, id, me, current ?? null);
  const tp = findTitleProp(propsLite);
  recordActivity(guard, "claimed", "task", tp ? String((row.props as Record<string, unknown>)[tp.id] ?? "(제목 없음)") : "(제목 없음)", id);
  return NextResponse.json({ ok: true, assignee: me, status: inProgress ? "진행 중" : undefined });
}
