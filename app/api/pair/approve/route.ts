import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { generateAgentToken, hashToken, agentEmail } from "@/lib/agentToken";

export const runtime = "nodejs";

// POST /api/pair/approve { code } — 로그인 사용자가 CLI 페어링을 승인.
// 에이전트 토큰(+시스템 User+멤버십)을 발급하고 code 에 결속한다. 재승인 시 code upsert.
export async function POST(req: Request) {
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  const { code } = (await req.json().catch(() => ({}))) as { code?: string };
  if (!code || !/^[0-9a-f]{32}$/.test(code)) {
    return NextResponse.json({ error: "유효하지 않은 페어링 코드입니다." }, { status: 400 });
  }
  const token = generateAgentToken();
  const name = `setup:${new Date().toISOString().slice(0, 10)}`;
  const prior = await prisma.pairing.findUnique({ where: { code }, select: { agentTokenId: true } });
  await prisma.$transaction(async (tx) => {
    // 재승인(같은 code 로 다시 승인)이면 구 토큰을 먼저 무력화 — 고아 유효 토큰 방지
    if (prior?.agentTokenId) {
      await tx.agentToken.update({ where: { id: prior.agentTokenId }, data: { revokedAt: new Date() } });
    }
    // 시스템 User → 토큰 → 이메일을 토큰 id 기반으로 확정 → 멤버십(일급 팀원 노출) — agent-tokens POST 와 동일 패턴
    const user = await tx.user.create({
      data: { email: `pending-${hashToken(token).slice(0, 24)}@agents.teamspace.local`, name },
      select: { id: true },
    });
    const t = await tx.agentToken.create({
      data: { workspaceId: guard.workspaceId, userId: user.id, name, role: "editor", tokenHash: hashToken(token) },
    });
    await tx.user.update({ where: { id: user.id }, data: { email: agentEmail(t.id) } });
    await tx.workspaceMember.create({
      data: { workspaceId: guard.workspaceId, userId: user.id, role: "editor", status: "active" },
    });
    await tx.pairing.upsert({
      where: { code },
      create: { code, workspaceId: guard.workspaceId, userId: user.id, agentTokenId: t.id, token },
      update: {
        workspaceId: guard.workspaceId,
        userId: user.id,
        agentTokenId: t.id,
        token,
        tokenDeliveredAt: null,
        createdAt: new Date(),
      },
    });
  });
  return NextResponse.json({ ok: true });
}
