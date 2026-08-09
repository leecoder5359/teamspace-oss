import { prisma } from "@/lib/prisma";
import { isRestrictedPage } from "@/lib/pageGuard";
import { pushNotification, userIdsByNames } from "@/lib/activity";
import { postMessage } from "@/lib/slack";
import type { NotifEvent } from "@/app/generated/prisma/enums";

/** 프로젝트 규칙이 있으면 그것만, 없으면 전역(projectId=null) 규칙. 가장 구체적 우선. */
export function selectRules<T extends { projectId: string | null }>(rules: T[], projectId: string | null): T[] {
  if (projectId != null) {
    const scoped = rules.filter((r) => r.projectId === projectId);
    if (scoped.length > 0) return scoped;
  }
  return rules.filter((r) => r.projectId === null);
}

/**
 * 도메인 이벤트 발생 시 매칭되는 NotifRule(활성·target=channel)로 슬랙 알림 발송.
 * 발송은 postMessage 경유라 NotifLog(kind: notification)에 자동 기록된다.
 * 알림 실패가 도메인 작업(태스크 생성/변경)을 막지 않도록 모두 안전 처리.
 */
export async function fireNotif(workspaceId: string, event: NotifEvent, text: string, projectId?: string | null): Promise<void> {
  try {
    const rules = await prisma.notifRule.findMany({
      where: { workspaceId, event, enabled: true, target: "channel" },
    });
    const selected = selectRules(rules, projectId ?? null);
    await Promise.all(
      selected.map((r) =>
        postMessage(workspaceId, { channel: r.targetId, text, kind: "notification" }).catch(() => undefined),
      ),
    );
  } catch {
    /* 알림은 베스트에포트 */
  }
}

/* ── 태스크(보드 행) 이벤트 헬퍼 ── */
type PropLite = { id: string; name: string; type: string; config: unknown };

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
function titleOf(props: PropLite[], rowProps: Record<string, unknown>): string {
  const tp = props.find((p) => p.type === "text") ?? props[0];
  const v = tp ? rowProps[tp.id] : undefined;
  return (typeof v === "string" && v) || "(제목 없음)";
}
function statusOf(props: PropLite[], rowProps: Record<string, unknown>): string | null {
  const sp = props.find((p) => p.type === "select" && /상태|status/i.test(p.name)) ?? props.find((p) => p.type === "select");
  if (!sp) return null;
  const opts = ((sp.config as { options?: { id: string; name: string }[] })?.options) ?? [];
  return opts.find((o) => o.id === rowProps[sp.id])?.name ?? null;
}

export async function notifyTaskCreated(databasePageId: string, rowProps: Record<string, unknown>): Promise<void> {
  try {
    const { workspaceId, projectId, props } = await loadBoard(databasePageId);
    if (workspaceId) await fireNotif(workspaceId, "task_created", `🆕 새 태스크: ${titleOf(props, rowProps)}`, projectId);
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
    await fireNotif(workspaceId, "task_status", `🔄 ${titleOf(props, newProps)} · 상태: ${oldS ?? "—"} → ${newS ?? "—"}`, projectId);
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
      `👤 ${title} · 담당: ${oldAssignee ? `${oldAssignee} → ` : ""}${newAssignee}`,
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
          `${overdue ? "⏰ 마감 지남" : "📅 오늘 마감"}: ${titleOf(props, rp)} (마감 ${due})`,
          board.projectId,
        );
        await prisma.notifLog
          .create({ data: { workspaceId: board.workspaceId, channel: "-", text: ref, kind: "due_marker", state: "sent" } })
          .catch(() => {});
        // 인앱 인박스: 담당자에게도 적재 (W6 inv-4)
        const assignee = assigneeProp ? ((rp[assigneeProp.id] as string | undefined)?.trim() ?? "") : "";
        if (assignee) {
          const ids = await userIdsByNames(board.workspaceId, [assignee]);
          await pushNotification(board.workspaceId, ids, "due", `${overdue ? "⏰ 마감 지남" : "📅 오늘 마감"}: ${titleOf(props, rp)}`, `/p/${board.id}`);
        }
        notified++;
      }
    }
  } catch {
    /* best-effort */
  }
  return { notified };
}
