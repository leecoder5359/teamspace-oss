import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { pushNotification, recordActivity } from "@/lib/activity";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";

const ProposalPatchBody = z.object({
  action: z.string().optional(),
  note: z.string().optional(),
});

export const runtime = "nodejs";

// PATCH /api/proposals/[id] { action: "approve"|"reject", note? } → 검토 (admin).
// approve: kind 에 따라 Lesson 또는 Decision(accepted) 생성. 재검토는 409.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;

  const proposal = await prisma.proposal.findUnique({ where: { id } });
  if (!proposal || proposal.workspaceId !== guard.workspaceId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (proposal.status !== "pending") {
    return NextResponse.json({ error: `이미 ${proposal.status} 처리된 제안입니다.` }, { status: 409 });
  }

  const parsed = await readBody(req, ProposalPatchBody);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  if (body.action !== "approve" && body.action !== "reject") {
    return NextResponse.json({ error: 'action 은 "approve" 또는 "reject".' }, { status: 400 });
  }

  let createdId: string | null = null;
  if (body.action === "approve") {
    if (proposal.kind === "lesson") {
      const lesson = await prisma.lesson.create({
        data: {
          workspaceId: guard.workspaceId,
          projectId: proposal.projectId,
          title: proposal.title,
          body: proposal.body,
          createdById: proposal.proposedById,
        },
      });
      createdId = lesson.id;
    } else {
      const decision = await prisma.decision.create({
        data: {
          workspaceId: guard.workspaceId,
          projectId: proposal.projectId,
          title: proposal.title,
          decision: proposal.body,
          status: "accepted",
        },
      });
      createdId = decision.id;
    }
  }

  await prisma.proposal.update({
    where: { id },
    data: {
      status: body.action === "approve" ? "approved" : "rejected",
      reviewedById: guard.userId,
      reviewNote: body.note?.trim() || null,
      reviewedAt: new Date(),
    },
  });

  // 제안자에게 결과 알림
  if (proposal.proposedById) {
    await pushNotification(
      guard.workspaceId,
      [proposal.proposedById],
      "proposal",
      body.action === "approve"
        ? `✅ 제안 승인됨(${proposal.kind === "lesson" ? "규칙" : "결정"}): ${proposal.title}`
        : `❌ 제안 거부됨: ${proposal.title}${body.note ? ` — ${body.note}` : ""}`,
      "/docs",
      guard.userId,
    );
  }
  recordActivity(guard, body.action === "approve" ? "approved" : "rejected", "proposal", proposal.title, id);
  return NextResponse.json({ ok: true, createdId });
}

// DELETE /api/proposals/[id] — 본인 제안(pending)만 철회
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const proposal = await prisma.proposal.findUnique({ where: { id } });
  if (!proposal || proposal.workspaceId !== guard.workspaceId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (proposal.status !== "pending") {
    return NextResponse.json({ error: "처리된 제안은 철회할 수 없습니다." }, { status: 409 });
  }
  if (proposal.proposedById !== guard.userId && guard.role !== "admin") {
    return NextResponse.json({ error: "본인 제안만 철회할 수 있습니다." }, { status: 403 });
  }
  await prisma.proposal.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
