import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx, WS_COOKIE } from "@/lib/workspace";

export const runtime = "nodejs";

// GET /api/workspaces → 현재 사용자가 속한(활성) 워크스페이스 목록
export async function GET() {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { userId, workspaceId } = guard;
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId, status: "active" },
    orderBy: { createdAt: "asc" },
    include: { workspace: { select: { id: true, name: true, _count: { select: { members: true } } } } },
  });
  return NextResponse.json({
    workspaces: memberships.map((m) => ({
      id: m.workspace.id,
      name: m.workspace.name,
      role: m.role,
      memberCount: m.workspace._count.members,
      current: m.workspace.id === workspaceId,
    })),
  });
}

// POST /api/workspaces → 새 워크스페이스 생성(생성자=admin) + 활성 전환
export async function POST(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { userId } = guard;
  const body = (await request.json().catch(() => ({}))) as { name?: string };
  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: "워크스페이스 이름을 입력해 주세요." }, { status: 400 });

  const ws = await prisma.workspace.create({
    data: { name, members: { create: { userId, role: "admin", status: "active" } } },
  });
  const res = NextResponse.json({ workspace: { id: ws.id, name: ws.name } });
  res.cookies.set(WS_COOKIE, ws.id, { path: "/", httpOnly: true, sameSite: "lax" });
  return res;
}
