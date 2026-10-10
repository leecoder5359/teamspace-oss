import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { readBody } from "@/lib/apiBody";
import { loadAccess, projectAccess } from "@/lib/pageGuard";
import { resolveProjectRef } from "@/lib/projectRef";
import { z } from "zod";

const ChangelogPatchBody = z.object({
  title: z.string().optional(),
  version: z.string().optional(),
  body: z.string().optional(),
  projectId: z.string().nullable().optional(), // ""·null = 공용으로 해제
});

export const runtime = "nodejs";

// PATCH /api/changelog/[id] → 변경 이력 수정(제목/버전/본문)
// 넘어온 필드만 고친다 — undefined 는 '건드리지 않음'이고 빈 문자열은 '비움'이다.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const found = await prisma.changelogEntry.findFirst({ where: { id, workspaceId }, select: { id: true, projectId: true } });
  if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // D3: 현재 프로젝트를 호출자가 편집할 수 없으면(숨김·보기 전용) 없는 항목과 같은 404.
  const idx = await loadAccess(guard);
  if (found.projectId && projectAccess(idx, found.projectId) !== "edit") return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = await readBody(req, ChangelogPatchBody);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  if (body.title !== undefined && !body.title.trim()) return NextResponse.json({ error: "제목을 입력해 주세요." }, { status: 400 });
  const ref = body.projectId === undefined ? null : await resolveProjectRef(body.projectId, workspaceId);
  if (ref && !ref.ok) return ref.err;
  if (ref?.ok && ref.projectId && projectAccess(idx, ref.projectId) !== "edit") {
    return NextResponse.json({ error: "프로젝트를 찾을 수 없습니다.", projectId: ref.projectId }, { status: 400 });
  }
  await prisma.changelogEntry.update({
    where: { id },
    data: {
      ...(ref ? { projectId: ref.projectId } : {}),
      ...(body.title !== undefined ? { title: body.title.trim() } : {}),
      ...(body.version !== undefined ? { version: body.version.trim() || null } : {}),
      ...(body.body !== undefined ? { body: body.body.trim() || null } : {}),
    },
  });
  return NextResponse.json({ ok: true });
}


// DELETE /api/changelog/[id]
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const found = await prisma.changelogEntry.findFirst({ where: { id, workspaceId }, select: { projectId: true } });
  // 편집 권한이 없는 프로젝트의 항목은 지울 수 없다(숨김·보기 전용 → 404).
  if (found?.projectId && projectAccess(await loadAccess(guard), found.projectId) !== "edit") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  await prisma.changelogEntry.deleteMany({ where: { id, workspaceId } });
  return NextResponse.json({ ok: true });
}
