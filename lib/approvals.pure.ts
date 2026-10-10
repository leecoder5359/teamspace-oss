// 승인 카드 순수 모듈 — Slack Block Kit 구성·결정 요약·KST 포맷·재결정 오류 해석.
// prisma·fetch·slack 을 import 하지 않는다(테스트가 모킹 없이 로드할 수 있어야 한다).
// IO(sendApproval·recordDecision·refreshDecisionCard·applyDecision)는 lib/approvals.ts 에 있고,
// 이 파일의 export 를 그대로 re-export 하므로 기존 import 경로(@/lib/approvals)는 바뀌지 않는다.

export type ApprovalStatusStr = "pending" | "approved" | "rejected" | "additional";

// ── Slack Block Kit 구성 (순수) ──────────────────────────────────────────
type Block = { type: string; [k: string]: unknown };

/** Slack header plain_text 는 150자 제한. 초과 시 149자 + "…" 로 truncate. */
function headerText(emoji: string, title: string): string {
  const t = `${emoji} ${title}`;
  return t.length <= 150 ? t : t.slice(0, 149) + "…";
}

export function buildApprovalCard(a: {
  id: string; title: string; body: string;
  kind: ApprovalKindStr; highRisk: boolean;
  requesterName?: string | null; projectName?: string | null; createdAt?: Date | null;
}): { text: string; attachments: { color: string; blocks: Block[] }[] } {
  const k = KIND_META[a.kind] ?? KIND_META.general;
  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: headerText(k.emoji, a.title), emoji: true } },
  ];
  const badges: { type: string; text: string }[] = [{ type: "mrkdwn", text: `${k.emoji} *${k.label}*` }];
  if (a.highRisk) badges.push({ type: "mrkdwn", text: "🔴 *고위험*" });
  blocks.push({ type: "context", elements: badges });
  blocks.push({ type: "section", text: { type: "mrkdwn", text: a.body || "_(내용 없음)_" } });

  const meta: string[] = [];
  if (a.requesterName) meta.push(`👤 ${a.requesterName}`);
  if (a.projectName) meta.push(`📁 ${a.projectName}`);
  if (a.createdAt) meta.push(`🕐 ${formatKST(a.createdAt)}`);
  if (meta.length) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: meta.join(" · ") }] });

  blocks.push({
    type: "actions", block_id: `approval_${a.id}`,
    elements: [
      { type: "button", action_id: "approve", value: a.id, style: "primary", text: { type: "plain_text", text: "✅ 승인", emoji: true } },
      { type: "button", action_id: "additional", value: a.id, text: { type: "plain_text", text: "✚ 추가요청", emoji: true } },
      { type: "button", action_id: "reject", value: a.id, style: "danger", text: { type: "plain_text", text: "✖ 거부", emoji: true } },
    ],
  });
  return { text: `승인 요청: ${a.title}`, attachments: [{ color: a.highRisk ? "#F0494E" : k.color, blocks }] };
}

/** 결정 결과를 메시지로 치환할 때 쓰는 요약 문구(순수). */
export function decisionSummary(status: ApprovalStatusStr, text?: string): string {
  if (status === "approved") return "✅ *승인됨*";
  if (status === "rejected") return `✖ *거부됨*${text ? ` — 사유: ${text}` : ""}`;
  if (status === "additional") return `✚ *추가 요청*${text ? `: ${text}` : ""}`;
  return "⏳ 대기 중";
}

/** 거부/추가요청 사유 입력 모달 view(순수). callback_id=approval_modal, private_metadata={approvalId,kind}, reason input block_id=reason/action_id=value/multiline. */
export function buildReasonModalView(args: { approvalId: string; kind: "reject" | "additional"; title: string }): Record<string, unknown> {
  const label = args.kind === "reject" ? "거부 사유" : "추가 요청 내용";
  const heading = args.kind === "reject" ? `〈${args.title}〉 거부 사유` : `〈${args.title}〉 추가 요청`;
  return {
    type: "modal",
    callback_id: "approval_modal",
    private_metadata: JSON.stringify({ approvalId: args.approvalId, kind: args.kind }),
    title: { type: "plain_text", text: args.kind === "reject" ? "거부 사유" : "추가 요청" },
    submit: { type: "plain_text", text: "보내기" },
    close: { type: "plain_text", text: "취소" },
    blocks: [
      { type: "context", elements: [{ type: "mrkdwn", text: heading }] },
      { type: "input", block_id: "reason", label: { type: "plain_text", text: label }, element: { type: "plain_text_input", action_id: "value", multiline: true } },
    ],
  };
}

const RESULT_COLOR: Record<ApprovalStatusStr, string> = {
  pending: "#9AA3AF", approved: "#12B886", rejected: "#F0494E", additional: "#9AA3AF",
};

export function buildResolvedCard(
  a: { title: string; body: string; kind: ApprovalKindStr },
  d: { status: ApprovalStatusStr; responseText?: string; responder?: string | null; at?: Date | null },
): { text: string; attachments: { color: string; blocks: Block[] }[] } {
  const k = KIND_META[a.kind] ?? KIND_META.general;
  const bits: string[] = [];
  if (d.responder) bits.push(d.responder);
  if (d.at) bits.push(formatKST(d.at));
  const resultLine = `${decisionSummary(d.status, d.responseText)}${bits.length ? ` · ${bits.join(" · ")}` : ""}`;
  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: headerText(k.emoji, a.title), emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: a.body || "_(내용 없음)_" } },
    { type: "context", elements: [{ type: "mrkdwn", text: resultLine }] },
  ];
  return { text: `${a.title} — ${decisionSummary(d.status, d.responseText)}`, attachments: [{ color: RESULT_COLOR[d.status], blocks }] };
}

export type ApprovalKindStr = "general" | "status" | "triage" | "doc" | "project" | "deploy";

export const KIND_META: Record<ApprovalKindStr, { emoji: string; label: string; color: string }> = {
  general: { emoji: "📋", label: "일반", color: "#2F62FF" },
  status:  { emoji: "🔄", label: "상태", color: "#F5A623" },
  triage:  { emoji: "🩺", label: "분류", color: "#7165E3" },
  doc:     { emoji: "📄", label: "문서", color: "#2F62FF" },
  project: { emoji: "📁", label: "프로젝트", color: "#12B886" },
  deploy:  { emoji: "🚀", label: "배포", color: "#F0494E" },
};

/** Date → "YYYY-MM-DD HH:mm" (Asia/Seoul). */
export function formatKST(d: Date): string {
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}`;
}

/** `already_decided:<status>` 오류면 그 상태, 아니면 null. */
export function parseAlreadyDecided(err: unknown): ApprovalStatusStr | null {
  const m = err instanceof Error ? /^already_decided:(\w+)$/.exec(err.message) : null;
  return m ? (m[1] as ApprovalStatusStr) : null;
}

const STATUS_LABEL: Record<ApprovalStatusStr, string> = { pending: "대기", approved: "승인", rejected: "거부", additional: "추가 요청" };

/**
 * 이미 처리된 승인에 모달을 다시 제출했을 때의 view_submission 응답.
 * 500 을 내면 슬랙은 "문제가 발생했다" 만 보여 줘서, 사용자는 앞선 제출이 저장됐는지 모른 채 다시 누른다.
 */
export function alreadyDecidedModalResponse(status: ApprovalStatusStr): { response_action: "errors"; errors: { reason: string } } {
  return { response_action: "errors", errors: { reason: `이미 처리된 요청이에요(현재: ${STATUS_LABEL[status]}). 창을 닫아 주세요.` } };
}
