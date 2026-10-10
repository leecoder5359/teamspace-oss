import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { pushNotification, recordActivity } from "@/lib/activity";
import { withIdempotency } from "@/lib/idempotency";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";

const ProposalBody = z.object({
  kind: z.string().optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  projectId: z.string().nullable().optional(),
});

export const runtime = "nodejs";

// GET /api/proposals[?status=pending] → 지식 승격 제안 목록
export async function GET(req: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const status = new URL(req.url).searchParams.get("status");
  const proposals = await prisma.proposal.findMany({
    where: { workspaceId: guard.workspaceId, ...(status ? { status } : {}) },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return NextResponse.json({ proposals });
}

// POST /api/proposals { kind(lesson|decision), title, body, projectId? } → 제안 등록 (editor).
// admin 전원에게 인앱 알림 — 승인되면 레슨/결정으로 승격된다.
export async function POST(req: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  return withIdempotency(req, guard, async () => {
    const parsed = await readBody(req, ProposalBody);
    if (!parsed.ok) return parsed.res;
    const body = parsed.data;
    const kind = body.kind === "decision" ? "decision" : body.kind === "lesson" ? "lesson" : null;
    const title = body.title?.trim() ?? "";
    const text = body.body?.trim() ?? "";
    if (!kind || !title || !text) {
      return NextResponse.json({ error: "kind(lesson|decision)·title·body 가 필요합니다." }, { status: 400 });
    }
    if (body.projectId) {
      const p = await prisma.project.findUnique({ where: { id: body.projectId }, select: { workspaceId: true } });
      if (!p || p.workspaceId !== guard.workspaceId) {
        return NextResponse.json({ error: "프로젝트를 찾을 수 없습니다." }, { status: 400 });
      }
    }

    const proposal = await prisma.proposal.create({
      data: {
        workspaceId: guard.workspaceId,
        kind,
        title,
        body: text,
        projectId: body.projectId ?? null,
        proposedById: guard.userId,
        proposedByName: guard.actor.name,
      },
    });

    const admins = await prisma.workspaceMember.findMany({
      where: { workspaceId: guard.workspaceId, role: "admin", status: "active" },
      select: { userId: true },
    });
    await pushNotification(
      guard.workspaceId,
      admins.map((a) => a.userId),
      "proposal",
      `📥 지식 승격 제안(${kind === "lesson" ? "규칙" : "결정"}): ${title} — ${guard.actor.name}`,
      "/docs",
      guard.userId,
    );
    recordActivity(guard, "proposed", kind, title, proposal.id);
    return NextResponse.json({ proposal });
  });
}
