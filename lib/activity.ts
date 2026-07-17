import { prisma } from "@/lib/prisma";
import type { Ctx } from "@/lib/workspace";

/**
 * 활동 피드 기록 헬퍼 (W6 inv-5 — 경량 감사 로그).
 * 도메인 작업을 막지 않도록 항상 베스트에포트(실패 무시).
 */
export function recordActivity(
  ctx: Ctx,
  verb: string,
  targetType: string,
  targetTitle: string,
  targetId?: string | null,
): void {
  void prisma.activity
    .create({
      data: {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId,
        actorName: ctx.actor.name,
        verb,
        targetType,
        targetId: targetId ?? null,
        targetTitle: targetTitle.slice(0, 200),
      },
    })
    .catch(() => {});
}

/** 인앱 알림 적재 (W6 inv-4). 수신자 여러 명 가능, 자기 자신은 제외. */
export async function pushNotification(
  workspaceId: string,
  userIds: string[],
  type: string,
  title: string,
  link?: string | null,
  excludeUserId?: string,
): Promise<void> {
  const targets = [...new Set(userIds)].filter((u) => u && u !== excludeUserId);
  if (targets.length === 0) return;
  await prisma.notification
    .createMany({
      data: targets.map((userId) => ({
        workspaceId,
        userId,
        type,
        title: title.slice(0, 300),
        link: link ?? null,
      })),
    })
    .catch(() => {});
}

/** 멤버 이름 → User id 매핑 (담당자 텍스트·멘션 이름을 수신자로 변환). */
export async function userIdsByNames(workspaceId: string, names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId, status: "active", user: { is: { name: { in: names } } } },
    select: { userId: true },
  });
  return members.map((m) => m.userId);
}
