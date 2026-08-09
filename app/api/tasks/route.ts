import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { loadAccess, pageAccess } from "@/lib/pageGuard";
import { findAssigneeProp } from "@/lib/taskProps";

export const runtime = "nodejs";

type Opt = { id: string; name: string; color?: string };

// GET /api/tasks[?board=<id>&assignee=<이름|me>] → 태스크 보드 행을 {id,title,due,status,assignee} 단순형으로.
// board 미지정 시 첫 보드(캘린더/일정 뷰 호환). assignee=me 는 현재 액터 이름 (W5 task-6/10).
export async function GET(request: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const url = new URL(request.url);
  const boardParam = url.searchParams.get("board");
  const assigneeParam = url.searchParams.get("assignee");
  const assigneeFilter = assigneeParam === "me" ? guard.actor.name : assigneeParam;

  // D3: 지정 보드는 게이트를 통과해야 하고, 미지정일 때 고르는 '첫 보드' 도
  // **내가 볼 수 있는 것 중** 첫 번째여야 한다(안 그러면 남의 보드가 기본값이 된다).
  const idx = await loadAccess(guard);
  const candidates = await prisma.page.findMany({
    where: boardParam
      ? { id: boardParam, kind: "database", workspaceId, deletedAt: null }
      : { kind: "database", workspaceId, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  const db = candidates.find((c) => pageAccess(idx, c.id) !== "none") ?? null;
  if (!db) return NextResponse.json({ tasks: [], databaseId: null });

  const [props, rows] = await Promise.all([
    prisma.dbProperty.findMany({ where: { databasePageId: db.id }, orderBy: { position: "asc" } }),
    prisma.dbRow.findMany({ where: { databasePageId: db.id }, orderBy: { position: "asc" } }),
  ]);

  const titleProp = props.find((p) => p.type === "text") ?? props[0] ?? null;
  const dateProp = props.find((p) => p.type === "date") ?? null;
  const statusProp =
    props.find((p) => p.type === "select" && /status|상태/i.test(p.name)) ??
    props.find((p) => p.type === "select") ??
    null;

  const statusOpts: Opt[] = statusProp
    ? (((statusProp.config as { options?: Opt[] })?.options) ?? [])
    : [];
  const optName = (id: unknown) => statusOpts.find((o) => o.id === id);
  const assigneeProp = findAssigneeProp(
    props.map((p) => ({ id: p.id, name: p.name, type: p.type as string, config: p.config as { options?: Opt[] } })),
  );

  let tasks = rows.map((r) => {
    const p = r.props as Record<string, unknown>;
    const s = statusProp ? optName(p[statusProp.id]) : undefined;
    return {
      id: r.id,
      title: (titleProp ? (p[titleProp.id] as string) : "") || "(제목 없음)",
      due: dateProp ? ((p[dateProp.id] as string) ?? null) : null,
      status: s?.name ?? null,
      statusColor: s?.color ?? null,
      assignee: assigneeProp ? (((p[assigneeProp.id] as string) ?? "").trim() || null) : null,
    };
  });
  if (assigneeFilter) tasks = tasks.filter((t) => t.assignee === assigneeFilter);

  return NextResponse.json({ tasks, databaseId: db.id });
}
