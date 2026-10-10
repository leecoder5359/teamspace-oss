import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { applyDecision, type ApprovalStatusStr } from "@/lib/approvals";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";

const ApprovalPatchBody = z.object({
  status: z.string().optional(),
  responseText: z.string().optional(),
});

export const runtime = "nodejs";

// GET /api/approvals/[id] → 단일 승인 상태(에이전트 폴링용)
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const approval = await prisma.approval.findFirst({ where: { id, workspaceId } });
  if (!approval) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ approval });
}

// PATCH /api/approvals/[id] → 앱에서 직접 결정(승인/거부/추가요청). 슬랙 메시지도 갱신.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const approval = await prisma.approval.findFirst({ where: { id, workspaceId }, select: { id: true, status: true, highRisk: true } });
  if (!approval) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // 고위험 승인은 사람만 결정한다(env 금고 P1 — 승인 경로 보강).
  // 에이전트 토큰이 자기가 올린 고위험 요청을 스스로 승인하면 '사람 확인'이 무의미해진다.
  if (approval.highRisk && guard.actor.type === "agent") {
    return NextResponse.json({ error: "고위험 승인은 사람(로그인 세션·슬랙 버튼)만 결정할 수 있습니다." }, { status: 403 });
  }
  // 재결정 가드(W8 agent-9): 이미 결정된 승인은 뒤집을 수 없다
  if (approval.status !== "pending") {
    return NextResponse.json({ error: `이미 ${approval.status} 로 결정된 승인입니다.`, status: approval.status }, { status: 409 });
  }

  const parsed = await readBody(req, ApprovalPatchBody);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  const allowed: ApprovalStatusStr[] = ["approved", "rejected", "additional"];
  if (!allowed.includes(body.status as ApprovalStatusStr)) {
    return NextResponse.json({ error: "invalid status" }, { status: 400 });
  }
  await applyDecision(id, {
    status: body.status as ApprovalStatusStr,
    responseText: body.responseText?.trim() || undefined,
    userId: guard.userId, // 결정자 기록 (agents-extra-2)
  });
  return NextResponse.json({ ok: true });
}
