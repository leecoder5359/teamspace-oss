import { isAgentEmail } from "./agentToken";

/** 멤버 목록을 사람/에이전트로 분리한다(순수, 순서 보존, 입력 불변). */
export function splitMembers<T extends { user: { email: string } }>(
  members: readonly T[],
): { humans: T[]; agents: T[] } {
  const humans: T[] = [];
  const agents: T[] = [];
  for (const m of members) (isAgentEmail(m.user.email) ? agents : humans).push(m);
  return { humans, agents };
}

/** createdAt 내림차순으로 정렬된 토큰 행에서 유저별 가장 최근 1건만 남긴다. */
export function latestTokenByUser<T extends { userId: string }>(rows: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const r of rows) if (!map.has(r.userId)) map.set(r.userId, r);
  return map;
}
