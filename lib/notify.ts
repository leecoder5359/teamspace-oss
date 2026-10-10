import { prisma } from "@/lib/prisma";
import { isRestrictedPage } from "@/lib/pageGuard";
import { pushNotification, userIdsByNames } from "@/lib/activity";
import { postMessage } from "@/lib/slack";
import type { NotifEvent } from "@/app/generated/prisma/enums";
import {
  selectRules,
  statusOf,
  taskAssignedMessage,
  taskCreatedMessage,
  taskDueInboxMessage,
  taskDueMessage,
  taskStatusMessage,
  titleOf,
  type PropLite,
} from "./notify.pure";

// 알림 IO(DB 조회·슬랙 발송). 규칙 선택·행 속성 해석·메시지 조립은 lib/notify.pure.ts 로 분리했고,
// 아래 re-export 로 기존 import 경로(@/lib/notify)를 유지한다.
export * from "./notify.pure";

/** fireNotif 결과 — 기존 호출부(void fireNotif(...))는 무시해도 된다. */
export type NotifResult = {
  /** 성공적으로 보낸 채널 수 */
  delivered: number;
  /** 실패한 발송 수(슬랙 오류·예외) */
  failed: number;
  /** 첫 실패 사유(슬랙 error 코드 또는 예외 메시지) */
  error?: string;
  /** 보낼 곳이 없었다 — 매칭 규칙 없음(폴백 없을 때), 또는 폴백했는데 Slack 미연결·기본 채널 없음 */
  noTarget?: boolean;
};

/**
 * 도메인 이벤트 발생 시 매칭되는 NotifRule(활성·target=channel)로 슬랙 알림 발송.
 * 규칙 선택은 selectRules — 프로젝트 규칙이 있으면 그것만, 없으면 전역(projectId=null) 규칙.
 * `fallbackToDefault` 면 매칭 규칙이 하나도 없을 때 SlackInstall 기본 채널로 보낸다(주간 다이제스트 —
 * 규칙을 만들기 전에도 종전처럼 기본 채널로 가야 한다). text 는 가공하지 않고 그대로 postMessage 에 넘긴다
 * (자르기·이스케이프 없음 — 다이제스트 mrkdwn 이 그대로 간다).
 * 발송은 postMessage 경유라 NotifLog(kind: opts.kind ?? "notification")에 자동 기록된다.
 * 알림 실패가 도메인 작업(태스크 생성/변경)을 막지 않도록 throw 하지 않는다 — 결과만 돌려준다.
 */
export async function fireNotif(
  workspaceId: string,
  event: NotifEvent,
  text: string,
  projectId?: string | null,
  opts: { kind?: string; fallbackToDefault?: boolean } = {},
): Promise<NotifResult> {
  const kind = opts.kind ?? "notification";
  try {
    const rules = await prisma.notifRule.findMany({
      where: { workspaceId, event, enabled: true, target: "channel" },
    });
    const selected = selectRules(rules, projectId ?? null);
    if (selected.length === 0) {
      if (!opts.fallbackToDefault) return { delivered: 0, failed: 0, noTarget: true };
      const r = await postMessage(workspaceId, { text, kind });
      if (r.ok) return { delivered: 1, failed: 0 };
      if (r.error === "no_channel" || r.error === "not_connected") return { delivered: 0, failed: 0, noTarget: true, error: r.error };
      return { delivered: 0, failed: 1, error: r.error };
    }
    const results = await Promise.all(
      selected.map((r) =>
        postMessage(workspaceId, { channel: r.targetId, text, kind }).catch((e: unknown) => ({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        })),
      ),
    );
    const bad = results.filter((r) => !r.ok);
    return { delivered: results.length - bad.length, failed: bad.length, ...(bad.length ? { error: bad[0].error ?? "post_failed" } : {}) };
  } catch (e) {
    /* 알림은 베스트에포트 — 규칙 조회 실패 등 */
    return { delivered: 0, failed: 1, error: e instanceof Error ? e.message : String(e) };
  }
}

/* ── 태스크(보드 행) 이벤트 헬퍼 ── */
async function loadBoard(databasePageId: string): Promise<{ workspaceId: string | null; projectId: string | null; props: PropLite[] }> {
  const page = await prisma.page.findUnique({ where: { id: databasePageId }, select: { workspaceId: true, projectId: true } });
  const props = (await prisma.dbProperty.findMany({ where: { databasePageId } })) as unknown as PropLite[];

  /* D3 후속: **비공개 보드의 내용을 채널로 뿌리지 않는다.**
     알림은 규칙에 걸린 슬랙 채널(대개 팀 전체)로 나가는데, 태스크 제목은 그
     자체가 내용이다. 보드를 잠근 의미가 알림 한 줄로 무너지면 안 된다.
     workspaceId 를 null 로 돌려 호출부의 발화를 통째로 끊는다 — 호출부마다
     조건을 흩뿌리면 언젠가 한 곳이 빠진다. */
  if (page && (await isRestrictedPage(databasePageId))) {
    return { workspaceId: null, projectId: null, props };
  }
  return { workspaceId: page?.workspaceId ?? null, projectId: page?.projectId ?? null, props };
}

export async function notifyTaskCreated(databasePageId: string, rowProps: Record<string, unknown>): Promise<void> {
  try {
    const { workspaceId, projectId, props } = await loadBoard(databasePageId);
    if (workspaceId) await fireNotif(workspaceId, "task_created", taskCreatedMessage(titleOf(props, rowProps)), projectId);
  } catch {
    /* best-effort */
  }
}

export async function notifyTaskStatus(databasePageId: string, oldProps: Record<string, unknown>, newProps: Record<string, unknown>): Promise<void> {
  try {
    const { workspaceId, projectId, props } = await loadBoard(databasePageId);
    if (!workspaceId) return;
    const oldS = statusOf(props, oldProps);
    const newS = statusOf(props, newProps);
    if (oldS === newS) return;
    await fireNotif(workspaceId, "task_status", taskStatusMessage(titleOf(props, newProps), oldS, newS), projectId);
  } catch {
    /* best-effort */
  }
}

/** 담당자 변경 알림 (W5 task-5): claim·rows PATCH 에서 담당자 값이 바뀔 때 발화. */
export async function notifyTaskAssigned(
  databasePageId: string,
  rowId: string,
  newAssignee: string,
  oldAssignee: string | null,
): Promise<void> {
  try {
    if (!newAssignee || newAssignee === oldAssignee) return;
    const { workspaceId, projectId, props } = await loadBoard(databasePageId);
    if (!workspaceId) return;
    const row = await prisma.dbRow.findUnique({ where: { id: rowId }, select: { props: true } });
    const title = row ? titleOf(props, row.props as Record<string, unknown>) : "(제목 없음)";
    await fireNotif(
      workspaceId,
      "task_assigned",
      taskAssignedMessage(title, oldAssignee, newAssignee),
      projectId,
    );
  } catch {
    /* best-effort */
  }
}

/**
 * 마감 임박/지남 알림 (W5 task-5): 워커가 주기 호출. 마감일이 오늘 이전(포함)이고
 * 완료가 아닌 태스크를 규칙 채널로 발송한다. NotifLog(kind=due_marker, text=due:row:date) 로 하루 1회 중복 방지.
 */
export async function notifyTasksDue(todayISO?: string): Promise<{ notified: number }> {
  const today = (todayISO ?? new Date().toISOString()).slice(0, 10);
  let notified = 0;
  try {
    const boards = await prisma.page.findMany({
      where: { kind: "database", deletedAt: null },
      select: { id: true, workspaceId: true, projectId: true },
    });
    for (const board of boards) {
      const rules = await prisma.notifRule.findMany({
        where: { workspaceId: board.workspaceId, event: "task_due", enabled: true, target: "channel" },
      });
      if (selectRules(rules, board.projectId).length === 0) continue;
      const props = (await prisma.dbProperty.findMany({ where: { databasePageId: board.id } })) as unknown as PropLite[];
      const dateProp = props.find((p) => p.type === "date");
      const assigneeProp = props.find((p) => (p.type === "text" || p.type === "person") && /담당|assignee|owner/i.test(p.name));
      const statusProp = props.find((p) => p.type === "select" && /상태|status/i.test(p.name)) ?? props.find((p) => p.type === "select");
      if (!dateProp) continue;
      const doneOpts = new Set(
        (((statusProp?.config as { options?: { id: string; name: string }[] })?.options) ?? [])
          .filter((o) => /완료|done/i.test(o.name))
          .map((o) => o.id),
      );
      const rows = await prisma.dbRow.findMany({ where: { databasePageId: board.id } });
      for (const row of rows) {
        const rp = row.props as Record<string, unknown>;
        const due = typeof rp[dateProp.id] === "string" ? (rp[dateProp.id] as string).slice(0, 10) : null;
        if (!due || due > today) continue;
        if (statusProp && doneOpts.has(rp[statusProp.id] as string)) continue;
        // 하루 1회 중복 방지: due_marker 행(kind)으로 기록 — 스키마 변경 없이 NotifLog 재사용
        const ref = `due:${row.id}:${today}`;
        const dup = await prisma.notifLog.findFirst({
          where: { workspaceId: board.workspaceId, kind: "due_marker", text: ref },
          select: { id: true },
        });
        if (dup) continue;
        const overdue = due < today;
        await fireNotif(
          board.workspaceId,
          "task_due",
          taskDueMessage(titleOf(props, rp), due, overdue),
          board.projectId,
        );
        await prisma.notifLog
          .create({ data: { workspaceId: board.workspaceId, channel: "-", text: ref, kind: "due_marker", state: "sent" } })
          .catch(() => {});
        // 인앱 인박스: 담당자에게도 적재 (W6 inv-4)
        const assignee = assigneeProp ? ((rp[assigneeProp.id] as string | undefined)?.trim() ?? "") : "";
        if (assignee) {
          const ids = await userIdsByNames(board.workspaceId, [assignee]);
          await pushNotification(board.workspaceId, ids, "due", taskDueInboxMessage(titleOf(props, rp), overdue), `/p/${board.id}`);
        }
        notified++;
      }
    }
  } catch {
    /* best-effort */
  }
  return { notified };
}
