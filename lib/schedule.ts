import { prisma } from "@/lib/prisma";

export type ReminderTemplate = {
  text: string;
  databasePageId?: string;
  rowId?: string;
};

/**
 * 간편 할일 알림: 특정 시각(once)에 발송될 예약 메시지를 등록한다.
 * Slack 연동(M4) 전에는 채널이 비어 있을 수 있으며, 발송 워커가 채널을 해석한다.
 */
export async function createReminder(
  workspaceId: string,
  remindAtISO: string,
  template: ReminderTemplate,
  channelId?: string,
) {
  // 채널 우선순위: 명시 channelId > SlackInstall 기본 채널 > pending("")
  // ("" 이면 발송 시 AUTH_SLACK_DEFAULT_CHANNEL 폴백 — 그것도 없으면 failed)
  const install = channelId
    ? null
    : await prisma.slackInstall.findUnique({
        where: { workspaceId },
        select: { defaultChannelId: true },
      });
  return prisma.schedule.create({
    data: {
      workspaceId,
      kind: "once",
      spec: remindAtISO,
      template: template as object,
      channelId: channelId ?? install?.defaultChannelId ?? "",
      status: "active",
    },
  });
}

export async function listReminders(workspaceId: string, databasePageId?: string) {
  const all = await prisma.schedule.findMany({
    where: { workspaceId, kind: "once", status: "active" },
    orderBy: { spec: "asc" },
  });
  if (!databasePageId) return all;
  return all.filter((s) => {
    const t = s.template as ReminderTemplate;
    return t?.databasePageId === databasePageId;
  });
}

/** 반복 리마인더 생성 (W7): kind=cron, spec=daily:HH:MM | weekly:DDD:HH:MM. 발송 후에도 active 유지. */
export async function createRecurring(
  workspaceId: string,
  spec: string,
  template: ReminderTemplate,
  channelId?: string,
) {
  const install = channelId
    ? null
    : await prisma.slackInstall.findUnique({ where: { workspaceId }, select: { defaultChannelId: true } });
  return prisma.schedule.create({
    data: {
      workspaceId,
      kind: "cron",
      spec,
      template: template as object,
      channelId: channelId ?? install?.defaultChannelId ?? "",
      status: "active",
    },
  });
}
