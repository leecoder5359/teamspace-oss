import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";

const WorkspacePatchBody = z.object({
  name: z.string().optional(),
});

export const runtime = "nodejs";

// GET /api/workspace → 현재 워크스페이스 정보 + 내 역할/프로필
export async function GET() {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId, userId } = guard;
  const [workspace, member, counts] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true, createdAt: true } }),
    prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true, user: { select: { name: true, email: true } } },
    }),
    prisma.workspaceMember.count({ where: { workspaceId } }),
  ]);
  return NextResponse.json({
    workspace,
    role: member?.role ?? null,
    me: member?.user ?? null,
    memberCount: counts,
  });
}

// PATCH /api/workspace → 워크스페이스 이름 변경(admin만)
export async function PATCH(request: Request) {
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  const { workspaceId, userId } = guard;
  const member = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  if (member?.role !== "admin") {
    return NextResponse.json({ error: "관리자만 변경할 수 있습니다." }, { status: 403 });
  }
  const parsed = await readBody(request, WorkspacePatchBody);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "이름을 입력해 주세요." }, { status: 400 });

  await prisma.workspace.update({ where: { id: workspaceId }, data: { name } });
  return NextResponse.json({ ok: true });
}
