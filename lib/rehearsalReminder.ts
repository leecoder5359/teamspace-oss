import { prisma } from "@/lib/prisma";
import { pushNotification } from "@/lib/activity";
import { isAgentEmail } from "@/lib/agentToken";
import { log } from "@/lib/log";
import { inRehearsalWindow, rehearsalQuarterKey } from "@/lib/rehearsalRecord";

export const REHEARSAL_REMINDER_TITLE = "분기 복원 리허설 — pnpm restore:rehearsal 실행 후 ws rehearsal record";
export const rehearsalMarkerRef = (quarterKey: string) => `rehearsal:${quarterKey}`;

const DAY_MS = 86_400_000;

/**
 * 분기 복원 리허설 리마인더(3단계 후속). 1·4·7·10월 첫 월요일(서버 로컬)에 워크스페이스마다
 * 관리자(사람만, 활성)에게 받은편지함 알림(type due, 링크 /settings)을 한 번 보낸다.
 *
 * 그날 09:00~09:59(로컬) 창에서만 동작한다(주간 다이제스트와 같은 방식).
 * 중복 방지는 digest/due 와 같은 NotifLog 마커(kind=rehearsal_marker, text=rehearsal:<YYYY-Qn>) —
 * 마커를 알림보다 **먼저** 쓴다. 마커 쓰기가 실패하면 알림도 안 나가므로 재알림이 없다.
 * 알림이 실패하면 마커를 지워(최선 노력) 창 안 다음 tick 에 재시도하고, failed 로 알려 워커가 그 분기를 확정하지 않게 한다.
 * 관리자가 없으면 마커도 남기지 않고 skipped 로 센다.
 */
export async function sendRehearsalReminders(now: Date = new Date()): Promise<{ quarter: string | null; notified: number; skipped: number; failed: number }> {
  if (!inRehearsalWindow(now)) return { quarter: null, notified: 0, skipped: 0, failed: 0 };
  const quarter = rehearsalQuarterKey(now);
  const ref = rehearsalMarkerRef(quarter);
  let notified = 0;
  let skipped = 0;
  let failed = 0;
  const workspaces = await prisma.workspace.findMany({ select: { id: true } });
  for (const w of workspaces) {
    try {
      // createdAt 하한 — [workspaceId, createdAt] 인덱스를 타게(첫 월요일은 1~7일이라 8일이면 충분)
      const dup = await prisma.notifLog.findFirst({
        where: { workspaceId: w.id, kind: "rehearsal_marker", text: ref, createdAt: { gte: new Date(now.getTime() - 8 * DAY_MS) } },
        select: { id: true },
      });
      if (dup) {
        skipped++;
        continue;
      }
      const admins = await prisma.workspaceMember.findMany({
        where: { workspaceId: w.id, role: "admin", status: "active" },
        select: { userId: true, user: { select: { email: true } } },
      });
      const ids = admins.filter((a) => !isAgentEmail(a.user.email)).map((a) => a.userId);
      if (ids.length === 0) {
        skipped++;
        continue;
      }
      const marker = await prisma.notifLog.create({ data: { workspaceId: w.id, channel: "-", text: ref, kind: "rehearsal_marker", state: "sent" }, select: { id: true } });
      try {
        await pushNotification(w.id, ids, "due", REHEARSAL_REMINDER_TITLE, "/settings");
      } catch (e) {
        // 알림이 안 나갔으니 마커를 거둬 재시도를 허용한다(지우기마저 실패하면 이번 분기는 놓친다 — 중복보다 낫다).
        await prisma.notifLog.delete({ where: { id: marker?.id } }).catch(() => {});
        throw e;
      }
      notified++;
    } catch (e) {
      failed++;
      log.warn("rehearsal.reminder_failed", { msg: "분기 복원 리허설 리마인더 실패", workspaceId: w.id, err: e });
    }
  }
  return { quarter, notified, skipped, failed };
}
