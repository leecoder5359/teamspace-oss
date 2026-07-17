import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { encryptToken } from "@/lib/crypto";
import { authTest } from "@/lib/slack";

export const runtime = "nodejs";

// POST /api/slack/connect → 봇 토큰 검증 후 암호화 저장(연결)
export async function POST(request: Request) {
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const body = (await request.json().catch(() => ({}))) as {
    token?: string;
    defaultChannelId?: string;
  };
  const token = body.token?.trim();
  if (!token) {
    return NextResponse.json({ error: "봇 토큰을 입력해 주세요." }, { status: 400 });
  }

  const auth = await authTest(token);
  if (!auth.ok) {
    return NextResponse.json({ error: `슬랙 인증 실패: ${auth.error}` }, { status: 400 });
  }

  const defaultChannelId = body.defaultChannelId?.trim() || null;
  await prisma.slackInstall.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      teamId: auth.teamId ?? "",
      botTokenEnc: encryptToken(token),
      defaultChannelId,
    },
    update: {
      teamId: auth.teamId ?? "",
      botTokenEnc: encryptToken(token),
      defaultChannelId,
    },
  });

  return NextResponse.json({
    connected: true,
    teamId: auth.teamId,
    teamName: auth.teamName,
    defaultChannelId,
  });
}
