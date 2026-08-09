import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveProjectRef } from "@/lib/projectRef";
import { requireCtx } from "@/lib/workspace";
import type { NotifEvent, NotifTarget } from "@/app/generated/prisma/enums";

export const runtime = "nodejs";

// NotifEvent enum 전체와 일치시킨다. 종전엔 task 4종만 허용해서, comment_added·doc_saved 는
// 규칙을 만들 방법이 없었고 그래서 pages/[id]/comments:84·pages/[id]:149 의 fireNotif 가
// 영구 무동작이었다 — SKILL.md 는 comment_added 발화를 약속하고 있었다(전수조사 D7).
const EVENTS: NotifEvent[] = ["task_created", "task_status", "task_assigned", "task_due", "comment_added", "doc_saved"];

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
  // 검증 없이 저장하면 selectRules 가 영원히 매칭하지 못해 '절대 발화하지 않는 규칙'이 된다(D5)
  const ref = await resolveProjectRef(body.projectId, workspaceId);
  if (!ref.ok) return ref.err;
  const rule = await prisma.notifRule.create({
    data: { workspaceId, event: body.event, target: "channel", targetId, projectId: ref.projectId },
  });
  return NextResponse.json({ rule });
}
