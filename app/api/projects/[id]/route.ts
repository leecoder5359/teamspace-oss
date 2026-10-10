import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveMemberRef } from "@/lib/projectRef";
import { requireCtx } from "@/lib/workspace";
import { requireProject } from "@/lib/pageGuard";
import { normalizeStack } from "@/lib/lessonInject";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";

const ProjectPatchBody = z.object({
  name: z.string().optional(),
  short: z.string().nullable().optional(),
  color: z.string().optional(),
  description: z.string().nullable().optional(),
  leadId: z.string().nullable().optional(),
  repoUrl: z.string().nullable().optional(),
  repoPath: z.string().nullable().optional(),
  repoBranch: z.string().nullable().optional(),
  docsDir: z.string().nullable().optional(),
  archived: z.boolean().optional(),
  stack: z.union([z.array(z.string()), z.string()]).nullable().optional(),
});

const COLORS = ["blue", "orange", "purple", "green", "red", "gray"];

// PATCH /api/projects/[id] → 이름/코드/색상/설명/리드 수정
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  // D3: 잠긴 프로젝트는 부여받은 사람만 고치거나 지운다.
  const gate = await requireProject(guard, id, "edit");
  if ("err" in gate) return gate.err;
  const { workspaceId } = guard;

  const project = await prisma.project.findUnique({ where: { id } });
  if (!project || project.workspaceId !== workspaceId) {
    return NextResponse.json({ error: "프로젝트를 찾을 수 없습니다." }, { status: 404 });
  }

  const parsed = await readBody(req, ProjectPatchBody);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  const data: Record<string, unknown> = {};
  if (body.stack !== undefined) {
    // 스택 태그 — 스택 레슨(Lesson.stack)이 이 프로젝트 세션에 들어갈지 정한다.
    const st = normalizeStack(body.stack ?? []);
    if (!st.ok) return NextResponse.json({ error: st.error }, { status: 400 });
    data.stack = st.stack;
  }
  // 보관(F10): true=지금 시각(이미 보관이면 원래 시각 유지) · false=해제. 기존 쓰기 게이트(edit) 그대로.
  if (body.archived !== undefined) data.archivedAt = body.archived ? (project.archivedAt ?? new Date()) : null;
  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (!name) return NextResponse.json({ error: "이름은 비울 수 없습니다." }, { status: 400 });
    data.name = name;
  }
  if (body.short !== undefined) data.short = body.short?.trim() || null;
  if (body.description !== undefined) data.description = body.description?.trim() || null;
  if (body.color !== undefined && COLORS.includes(body.color)) data.color = body.color;
  if (body.repoUrl !== undefined) data.repoUrl = body.repoUrl?.trim() || null;
  if (body.repoPath !== undefined) data.repoPath = body.repoPath?.trim() || null;
  if (body.repoBranch !== undefined) data.repoBranch = body.repoBranch?.trim() || null;
  if (body.docsDir !== undefined) data.docsDir = body.docsDir?.trim() || null;
  if (body.leadId !== undefined) {
    // 종전엔 멤버가 아니면 data.leadId = null 로 **기존 리드까지 지웠다** — 잘못된 값을
    // 보낸 벌로 멀쩡한 데이터를 날리는 셈이라 가장 나쁜 형태였다(D5).
    const lead = await resolveMemberRef(body.leadId, workspaceId, "프로젝트 리드");
    if (!lead.ok) return lead.err;
    data.leadId = lead.userId;
  }

  const updated = await prisma.project.update({ where: { id }, data });
  return NextResponse.json({ project: updated });
}

// DELETE /api/projects/[id] → 프로젝트 삭제 (소속 페이지는 projectId만 해제: SetNull)
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  // D3: 잠긴 프로젝트는 부여받은 사람만 고치거나 지운다.
  const gate = await requireProject(guard, id, "edit");
  if ("err" in gate) return gate.err;
  const { workspaceId } = guard;

  const project = await prisma.project.findUnique({ where: { id } });
  if (!project || project.workspaceId !== workspaceId) {
    return NextResponse.json({ error: "프로젝트를 찾을 수 없습니다." }, { status: 404 });
  }

  await prisma.project.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
