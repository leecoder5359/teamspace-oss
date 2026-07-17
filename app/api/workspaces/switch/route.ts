import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx, WS_COOKIE } from "@/lib/workspace";

export const runtime = "nodejs";

// POST /api/workspaces/switch → 활성 워크스페이스 전환(멤버십 검증 후 쿠키 설정)
export async function POST(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { userId } = guard;
  const body = (await request.json().catch(() => ({}))) as { workspaceId?: string };
  const workspaceId = body.workspaceId;
  if (!workspaceId) return NextResponse.json({ error: "workspaceId가 필요합니다." }, { status: 400 });

  const member = await prisma.workspaceMember.findFirst({
    where: { userId, workspaceId, status: "active" },
    select: { id: true },
  });
  if (!member) return NextResponse.json({ error: "해당 워크스페이스의 멤버가 아닙니다." }, { status: 403 });

  const res = NextResponse.json({ ok: true, workspaceId });
  res.cookies.set(WS_COOKIE, workspaceId, { path: "/", httpOnly: true, sameSite: "lax" });
  return res;
}
