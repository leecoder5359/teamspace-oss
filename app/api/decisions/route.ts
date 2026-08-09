import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveProjectRef } from "@/lib/projectRef";
import { requireCtx } from "@/lib/workspace";
import { recordActivity } from "@/lib/activity";

export const runtime = "nodejs";

const STATUSES = ["proposed", "accepted", "superseded"] as const;
type Status = (typeof STATUSES)[number];

// GET /api/decisions?projectId=... → 결정 목록(최신순)
export async function GET(request: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId");
  const decisions = await prisma.decision.findMany({
    where: { workspaceId, ...(projectId ? { projectId } : {}) },
    orderBy: { decidedAt: "desc" },
    take: 200,
    include: { project: { select: { name: true, color: true } } },
  });
  return NextResponse.json({ decisions });
}

// POST /api/decisions → 결정 생성
export async function POST(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const body = (await request.json().catch(() => ({}))) as {
    title?: string;
    context?: string;
    decision?: string;
    status?: string;
    projectId?: string;
  };
  const title = body.title?.trim();
  if (!title) return NextResponse.json({ error: "제목을 입력해 주세요." }, { status: 400 });

  // 없는/남의 프로젝트는 조용히 null 로 버리지 않고 400 으로 알린다(D5)
  const ref = await resolveProjectRef(body.projectId, workspaceId);
  if (!ref.ok) return ref.err;
  const projectId = ref.projectId;
  const status: Status = STATUSES.includes(body.status as Status) ? (body.status as Status) : "accepted";

  const created = await prisma.decision.create({
    data: {
      workspaceId,
      projectId,
      title,
      context: body.context?.trim() || null,
      decision: body.decision?.trim() || null,
      status,
    },
  });
  recordActivity(guard, "created", "decision", title, created.id);
  return NextResponse.json({ id: created.id });
}
