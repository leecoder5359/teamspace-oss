import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { withIdempotency } from "@/lib/idempotency";
import { pushNotification, recordActivity } from "@/lib/activity";
import { sendApproval } from "@/lib/approvals";

export const runtime = "nodejs";

// GET /api/approvals → 워크스페이스 승인 요청 목록(최신순)
export async function GET() {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const approvals = await prisma.approval.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return NextResponse.json({ approvals });
}

// POST /api/approvals → 승인 요청 생성 + 슬랙 발송
export async function POST(request: Request) {
  try {
    const guard = await requireCtx("editor");
    if ("err" in guard) return guard.err;
    const { workspaceId, userId } = guard;
    return withIdempotency(request, guard, async () => {
    const body = (await request.json().catch(() => ({}))) as {
      title?: string;
      body?: string;
      channel?: string;
      kind?: string;
      highRisk?: boolean;
      projectId?: string;
    };
    const title = body.title?.trim();
    if (!title) return NextResponse.json({ error: "제목을 입력해 주세요." }, { status: 400 });
    const result = await sendApproval(workspaceId, {
      title, body: body.body?.trim() || "", channel: body.channel?.trim() || undefined,
      kind: body.kind as "general" | "status" | "triage" | "doc" | "project" | "deploy" | undefined,
      highRisk: !!body.highRisk, createdBy: userId, projectId: body.projectId?.trim() || undefined,
    });
    // 인앱 알림: admin 전원에게 승인 요청 (W6 inv-4)
    const admins = await prisma.workspaceMember.findMany({
      where: { workspaceId, role: "admin", status: "active" },
      select: { userId: true },
    });
    await pushNotification(workspaceId, admins.map((a) => a.userId), "approval", `🙋 승인 요청: ${title}`, "/approvals", userId);
    recordActivity(guard, "requested", "approval", title);
    return NextResponse.json(result);
    });
  } catch (e) {
    console.error("[approvals POST]", e);
    return NextResponse.json({ error: "승인 생성에 실패했습니다." }, { status: 500 });
  }
}
