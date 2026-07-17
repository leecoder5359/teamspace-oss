import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { authTest, getSlackConfig } from "@/lib/slack";

export const runtime = "nodejs";

// GET /api/slack → 연결 상태(토큰 미반환). source=env|db, teamName 은 토큰으로 즉석 조회.
export async function GET() {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const cfg = await getSlackConfig(workspaceId);
  if (!cfg) return NextResponse.json({ connected: false });

  let teamId: string | undefined;
  let teamName: string | undefined;
  try {
    const auth = await authTest(cfg.token);
    if (auth.ok) {
      teamId = auth.teamId;
      teamName = auth.teamName;
    }
  } catch {
    // 토큰 검증 실패는 상태 표시에 치명적이지 않음
  }

  return NextResponse.json({
    connected: true,
    source: cfg.source,
    teamId,
    teamName,
    defaultChannelId: cfg.defaultChannelId,
  });
}

// PATCH /api/slack → 기본 채널 변경
export async function PATCH(request: Request) {
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const body = (await request.json().catch(() => ({}))) as { defaultChannelId?: string | null };
  const install = await prisma.slackInstall.findUnique({ where: { workspaceId } });
  const defaultChannelId = body.defaultChannelId?.trim() || null;

  if (!install) {
    // env 토큰 모드: 토큰은 env 가 담당하고, 기본 채널만 담는 자리표시 행을 만든다.
    if (!process.env.AUTH_SLACK_BOT_TOKEN?.trim()) {
      return NextResponse.json({ error: "연결되어 있지 않습니다." }, { status: 404 });
    }
    await prisma.slackInstall.create({
      data: { workspaceId, teamId: "env", botTokenEnc: "", defaultChannelId },
    });
    return NextResponse.json({ ok: true });
  }

  await prisma.slackInstall.update({
    where: { workspaceId },
    data: { defaultChannelId },
  });
  return NextResponse.json({ ok: true });
}

// DELETE /api/slack → 연결 해제
export async function DELETE() {
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  await prisma.slackInstall.deleteMany({ where: { workspaceId } });
  return NextResponse.json({ ok: true });
}
