import { prisma } from "@/lib/prisma";
import { splitMembers, latestTokenByUser } from "@/lib/membersSplit";

export type AgentTokenSummary = {
  id: string;
  name: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

/**
 * 에이전트 계정 멤버의 유저별 최신 토큰 요약(userId 키). 에이전트가 없으면 쿼리하지 않고,
 * 있으면 agentToken.findMany 를 한 번만 실행한다. 날짜는 ISO 문자열로 직렬화한다.
 */
export async function loadAgentTokenSummaries(
  workspaceId: string,
  members: readonly { userId: string; user: { email: string } }[],
): Promise<Map<string, AgentTokenSummary>> {
  const { agents } = splitMembers(members);
  if (agents.length === 0) return new Map();
  const rows = await prisma.agentToken.findMany({
    where: { workspaceId, userId: { in: agents.map((a) => a.userId) } },
    select: { id: true, name: true, userId: true, lastUsedAt: true, revokedAt: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const out = new Map<string, AgentTokenSummary>();
  for (const [userId, t] of latestTokenByUser(rows)) {
    out.set(userId, {
      id: t.id,
      name: t.name,
      lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
      revokedAt: t.revokedAt?.toISOString() ?? null,
    });
  }
  return out;
}
