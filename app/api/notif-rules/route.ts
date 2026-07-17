import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import type { NotifEvent, NotifTarget } from "@/app/generated/prisma/enums";

export const runtime = "nodejs";

const EVENTS: NotifEvent[] = ["task_created", "task_status", "task_assigned", "task_due"];

// GET /api/notif-rules → 자동 알림 규칙 목록
export async function GET() {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const rules = await prisma.notifRule.findMany({ where: { workspaceId }, orderBy: { createdAt: "asc" } });
  return NextResponse.json({ rules });
}

// POST /api/notif-rules → 규칙 생성 { event, targetId(채널), target? }
export async function POST(request: Request) {
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const body = (await request.json().catch(() => ({}))) as { event?: NotifEvent; targetId?: string; target?: NotifTarget; projectId?: string };
  if (!body.event || !EVENTS.includes(body.event)) {
    return NextResponse.json({ error: "유효한 이벤트를 선택해 주세요." }, { status: 400 });
  }
  // dm 타깃은 발화 경로가 아직 없다(감사 agents-extra-1) — 조용히 죽는 규칙을 만들지 않도록 명시 거부
  if (body.target === "dm") {
    return NextResponse.json({ error: "dm 타깃은 아직 지원되지 않습니다(채널만 가능)." }, { status: 400 });
  }
  const targetId = body.targetId?.trim();
  if (!targetId) return NextResponse.json({ error: "채널을 입력해 주세요." }, { status: 400 });
  const rule = await prisma.notifRule.create({
    data: { workspaceId, event: body.event, target: "channel", targetId, projectId: body.projectId?.trim() || null },
  });
  return NextResponse.json({ rule });
}
