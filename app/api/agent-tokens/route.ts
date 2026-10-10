import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { agentEmail, generateAgentToken, hashToken } from "@/lib/agentToken";
import { viewerPersonId } from "@/lib/viewerPerson";
import { isReservedAgentName } from "@/lib/bootstrapCtx";
import type { Role } from "@/app/generated/prisma/enums";
import { readBody } from "@/lib/apiBody";
import { z } from "zod";

const AgentTokenBody = z.object({
  name: z.string().optional(),
  role: z.string().optional(),
});

export const runtime = "nodejs";

const VALID_ROLES: Role[] = ["admin", "editor", "viewer"];

// GET /api/agent-tokens → 현재 워크스페이스 에이전트 토큰 목록 (해시·원문 미노출)
export async function GET() {
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  const tokens = await prisma.agentToken.findMany({
    where: { workspaceId: guard.workspaceId },
    select: {
      id: true,
      name: true,
      role: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
      user: { select: { id: true, name: true, email: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ tokens });
}

// POST /api/agent-tokens { name, role? } → 토큰 발급.
// 응답의 token(원문)은 이 1회만 노출된다. 에이전트용 시스템 User + 멤버십을 함께 생성해
// 작성자 기록·멤버 목록 노출이 사람 팀원과 동일하게 동작한다(일급 팀원).
export async function POST(req: Request) {
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  const parsed = await readBody(req, AgentTokenBody);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;

  const name = body.name?.trim() ?? "";
  if (!name) return NextResponse.json({ error: "에이전트 이름을 입력해 주세요." }, { status: 400 });
  if (isReservedAgentName(name)) return NextResponse.json({ error: "예약된 이름입니다. 다른 이름을 써 주세요." }, { status: 400 });
  const role: Role = body.role && VALID_ROLES.includes(body.role as Role) ? (body.role as Role) : "editor";

  const token = generateAgentToken();
  const created = await prisma.$transaction(async (tx) => {
    // 시스템 User → 토큰 → 이메일을 토큰 id 기반으로 확정 → 멤버십(일급 팀원 노출)
    const user = await tx.user.create({
      data: { email: `pending-${hashToken(token).slice(0, 24)}@agents.teamspace.local`, name },
      select: { id: true },
    });
    const t = await tx.agentToken.create({
      data: {
        workspaceId: guard.workspaceId,
        userId: user.id,
        // 발급자(사람) — 이 토큰 세션은 발급자의 개인 레슨을 받는다. 에이전트 토큰이 발급하면 그 토큰의 발급자를 잇는다.
        issuedById: viewerPersonId(guard),
        name,
        role,
        tokenHash: hashToken(token),
      },
    });
    await tx.user.update({ where: { id: user.id }, data: { email: agentEmail(t.id) } });
    await tx.workspaceMember.create({
      data: { workspaceId: guard.workspaceId, userId: user.id, role, status: "active" },
    });
    return t;
  });

  return NextResponse.json({
    token, // ⚠️ 1회 노출 — 저장해 두지 않으면 재발급해야 한다
    agentToken: { id: created.id, name: created.name, role: created.role, createdAt: created.createdAt },
  });
}
