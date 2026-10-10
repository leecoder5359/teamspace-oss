// 알림 순수 모듈 — 규칙 선택·보드 행 속성 해석·메시지 문자열 조립.
// prisma·slack·activity 를 import 하지 않는다(모킹 없이 로드 가능). 발송·DB 조회는 lib/notify.ts(IO).

export type PropLite = { id: string; name: string; type: string; config: unknown };

/** 프로젝트 규칙이 있으면 그것만, 없으면 전역(projectId=null) 규칙. 가장 구체적 우선. */
export function selectRules<T extends { projectId: string | null }>(rules: T[], projectId: string | null): T[] {
  if (projectId != null) {
    const scoped = rules.filter((r) => r.projectId === projectId);
    if (scoped.length > 0) return scoped;
  }
  return rules.filter((r) => r.projectId === null);
}

export function titleOf(props: PropLite[], rowProps: Record<string, unknown>): string {
  const tp = props.find((p) => p.type === "text") ?? props[0];
  const v = tp ? rowProps[tp.id] : undefined;
  return (typeof v === "string" && v) || "(제목 없음)";
}

export function statusOf(props: PropLite[], rowProps: Record<string, unknown>): string | null {
  const sp = props.find((p) => p.type === "select" && /상태|status/i.test(p.name)) ?? props.find((p) => p.type === "select");
  if (!sp) return null;
  const opts = ((sp.config as { options?: { id: string; name: string }[] })?.options) ?? [];
  return opts.find((o) => o.id === rowProps[sp.id])?.name ?? null;
}

/** notifyTaskCreated 의 알림 본문. */
export function taskCreatedMessage(title: string): string {
  return `🆕 새 태스크: ${title}`;
}

/** notifyTaskStatus 의 알림 본문. 상태가 없으면 "—". */
export function taskStatusMessage(title: string, oldStatus: string | null, newStatus: string | null): string {
  return `🔄 ${title} · 상태: ${oldStatus ?? "—"} → ${newStatus ?? "—"}`;
}

/** notifyTaskAssigned 의 알림 본문. 이전 담당자가 없으면 "→" 구간을 뺀다. */
export function taskAssignedMessage(title: string, oldAssignee: string | null, newAssignee: string): string {
  return `👤 ${title} · 담당: ${oldAssignee ? `${oldAssignee} → ` : ""}${newAssignee}`;
}

/** notifyTasksDue 의 인박스(담당자) 본문 — 채널 본문에서 "(마감 …)" 꼬리를 뺀 형태. */
export function taskDueInboxMessage(title: string, overdue: boolean): string {
  return `${overdue ? "⏰ 마감 지남" : "📅 오늘 마감"}: ${title}`;
}

/** notifyTasksDue 의 채널 알림 본문. */
export function taskDueMessage(title: string, due: string, overdue: boolean): string {
  return `${taskDueInboxMessage(title, overdue)} (마감 ${due})`;
}
