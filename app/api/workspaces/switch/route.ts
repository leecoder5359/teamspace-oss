import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx, WS_COOKIE } from "@/lib/workspace";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";

const SwitchBody = z.object({
  workspaceId: z.string().optional(),
});

export const runtime = "nodejs";

// POST /api/workspaces/switch → 활성 워크스페이스 전환(멤버십 검증 후 쿠키 설정)
export async function POST(request: Request) {
  // requireCtx 의 role 은 **전환 대상이 아니라 현재 활성 워크스페이스**의 것이다.
  // "editor" 를 요구하면 A 에서 viewer 인 사람은 B 에서 admin 이어도 B 로 못 간다 —
  // 전환은 현재 워크스페이스에 대한 쓰기가 아니므로 로그인만 요구하고,
  // 실제 판정은 아래 대상 워크스페이스 멤버십으로 한다(전수조사 D13).
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { userId } = guard;
  const parsed = await readBody(request, SwitchBody);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
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
