import { prisma } from "@/lib/prisma";
import { log } from "@/lib/log";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 오래된 미읽음 승인 요청 알림을 읽음 처리한다(B3).
 * 결정 시 읽음 처리는 링크에 approvalId 가 실린 신규 알림만 잡는다 — 그 전 알림(link="/approvals")과
 * 슬랙 밖에서 방치된 요청이 인박스 배지를 99+ 로 묶어 두지 않게 olderThanDays 가 지나면 정리한다.
 */
export async function autoReadStaleApprovalNotifications(
  workspaceId: string,
  olderThanDays = 14,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanDays * DAY_MS);
  const r = await prisma.notification.updateMany({
    where: { workspaceId, type: "approval", readAt: null, createdAt: { lt: cutoff } },
    data: { readAt: now },
  });
  return r.count;
}

/**
 * 인박스 종류 필터가 받는 알림 종류 — pushNotification 을 부르는 생산자가 실제로 쓰는 값과 같아야 한다.
 * (문서 코멘트 알림은 "comment" 가 아니라 "mention" 으로 쌓인다. 제안=proposal, 공유=shared.)
 */
export const NOTIF_FILTER_TYPES = ["approval", "assigned", "mention", "due", "proposal", "shared"] as const;

function splitNotifTypes(raw: string | null): string[] {
  return [...new Set((raw ?? "").split(",").map((t) => t.trim()).filter(Boolean))];
}

/** "?type=a,b" → 아는 종류만 중복 없이. 빈 배열이면 필터 없음. */
export function parseNotifTypes(raw: string | null): string[] {
  const known = NOTIF_FILTER_TYPES as readonly string[];
  return splitNotifTypes(raw).filter((t) => known.includes(t));
}

/** "?type=" 중 모르는 종류 — 있으면 라우트가 400 으로 거절한다(필터 없이 전체가 나가 "필터된 척" 하지 않게). */
export function unknownNotifTypes(raw: string | null): string[] {
  const known = NOTIF_FILTER_TYPES as readonly string[];
  return splitNotifTypes(raw).filter((t) => !known.includes(t));
}

// 워크스페이스별 24시간에 한 번 — 크론 대신 알림 조회 시점에 얹는다(모듈 스코프라 프로세스 재시작 시 다시 돈다. 멱등이라 무해).
const lastRunAt = new Map<string, number>();

/** 테스트 전용: 하루 1회 가드 초기화. */
export function __resetStaleApprovalGuard(): void {
  lastRunAt.clear();
}

/** 하루 1회 가드를 거쳐 autoReadStaleApprovalNotifications 를 돈다. 실패는 로그만(조회를 막지 않는다). */
export async function maybeAutoReadStaleApprovals(workspaceId: string, now = new Date()): Promise<void> {
  const t = now.getTime();
  const last = lastRunAt.get(workspaceId);
  if (last != null && t - last < DAY_MS) return;
  lastRunAt.set(workspaceId, t);
  try {
    await autoReadStaleApprovalNotifications(workspaceId, 14, now);
  } catch (e) {
    log.warn("notifications.auto_read_failed", { msg: "오래된 승인 알림 자동 읽음 실패", workspaceId, err: e });
  }
}
