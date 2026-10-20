import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { invalidateGraphCache } from "@/lib/graphLoad";
import { resolveProjectRef } from "@/lib/projectRef";
import { readBody } from "@/lib/apiBody";
import { promoteDecision, withLessonMeta } from "@/lib/lessonAccess";
import { viewerPersonId } from "@/lib/viewerPerson";

export const runtime = "nodejs";

const PromoteBody = z.object({ projectId: z.string().nullable().optional() });

// POST /api/lessons/[id]/promote { projectId? } → { lesson } — (admin) 개인 레슨을 팀 레슨으로: userId 를 비우고
// projectId 를 주면 그 프로젝트, 없으면 전역. 레슨 id 는 그대로(이미 가져간 복사본의 copiedFromId 도 유지).
// (주인이 PATCH personal:false 로 개인 레슨을 직접 전역으로 바꾸는 기존 경로는 그대로 둔다.)
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  const parsed = await readBody(req, PromoteBody);
  if (!parsed.ok) return parsed.res;
  const lesson = await prisma.lesson.findUnique({ where: { id } });
  if (!lesson || lesson.workspaceId !== guard.workspaceId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const d = promoteDecision(lesson, { personId: viewerPersonId(guard), role: guard.role });
  if (d === "not_personal") return NextResponse.json({ error: "개인 레슨만 팀 레슨으로 올릴 수 있습니다." }, { status: 400 });
  if (d === "forbidden") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const ref = await resolveProjectRef(parsed.data.projectId ?? null, guard.workspaceId);
  if (!ref.ok) return ref.err;
  const updated = await prisma.lesson.update({
    where: { id },
    data: { userId: null, projectId: ref.projectId, stack: null, sharedWithTeam: true },
  });
  invalidateGraphCache(guard.workspaceId); // 개인 → 팀: 그래프에 새로 들어온다
  return NextResponse.json({ lesson: withLessonMeta(updated) });
}
