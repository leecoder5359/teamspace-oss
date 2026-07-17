import { prisma } from "@/lib/prisma";
import { getSlackConfig } from "@/lib/slack";

const SLACK = "https://slack.com/api";

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

// ── 발송 / 결정 적용 (DB + Slack 네트워크) ───────────────────────────────
async function slackCall(token: string, method: string, body: Record<string, unknown>) {
  const res = await fetch(`${SLACK}/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  return res.json();
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

/** 승인 요청 생성 + 슬랙 인터랙티브 메시지 발송. */
export async function sendApproval(
  workspaceId: string,
  args: { title: string; body: string; channel?: string; kind?: ApprovalKindStr; highRisk?: boolean; createdBy?: string; projectId?: string },
): Promise<{ id: string; sent: boolean; error?: string }> {
  const KINDS: ApprovalKindStr[] = ["general", "status", "triage", "doc", "project", "deploy"];
  const approval = await prisma.approval.create({
    data: {
      workspaceId,
      title: args.title,
      body: args.body,
      kind: KINDS.includes(args.kind as ApprovalKindStr) ? (args.kind as ApprovalKindStr) : "general",
      highRisk: !!args.highRisk,
      ...(args.createdBy != null ? { createdBy: args.createdBy } : {}),
      ...(args.projectId != null ? { projectId: args.projectId } : {}),
    },
  });

  const cfg = await getSlackConfig(workspaceId);
  if (!cfg) return { id: approval.id, sent: false, error: "not_connected" };
  const channel = args.channel?.trim() || cfg.defaultChannelId;
  if (!channel) return { id: approval.id, sent: false, error: "no_channel" };

  const requester = approval.createdBy ? await prisma.user.findUnique({ where: { id: approval.createdBy } }) : null;
  const project = approval.projectId ? await prisma.project.findFirst({ where: { id: approval.projectId, workspaceId } }) : null;
  const card = buildApprovalCard({
    id: approval.id, title: approval.title, body: approval.body,
    kind: approval.kind as ApprovalKindStr, highRisk: approval.highRisk,
    requesterName: requester?.name ?? null, projectName: project?.name ?? null, createdAt: approval.createdAt,
  });

  const r = await slackCall(cfg.token, "chat.postMessage", { channel, text: card.text, attachments: card.attachments });
  await prisma.notifLog
    .create({
      data: {
        workspaceId,
        channel,
        text: card.text,
        kind: "approval",
        state: r.ok ? "sent" : "failed",
        error: r.ok ? null : (r.error ?? "post_failed"),
      },
    })
    .catch(() => {});
  if (!r.ok) return { id: approval.id, sent: false, error: r.error ?? "post_failed" };

  await prisma.approval.update({
    where: { id: approval.id },
    data: { slackChannel: r.channel, slackTs: r.ts },
  });
  return { id: approval.id, sent: true };
}

/** 결정 적용: DB 상태 갱신 + (가능하면) 원본 메시지를 결과로 치환. */
export async function applyDecision(
  approvalId: string,
  d: { status: ApprovalStatusStr; responseText?: string; userId?: string },
): Promise<void> {
  // 재결정 가드(W8 agent-9): pending 이 아닌 승인은 어떤 경로(앱·슬랙 버튼)로도 뒤집을 수 없다
  const current = await prisma.approval.findUnique({ where: { id: approvalId }, select: { status: true } });
  if (!current) throw new Error("approval not found");
  if (current.status !== "pending") {
    throw new Error(`already_decided:${current.status}`);
  }
  const approval = await prisma.approval.update({
    where: { id: approvalId },
    data: {
      status: d.status,
      responseText: d.responseText ?? null,
      respondedBy: d.userId ?? null,
      respondedAt: new Date(),
    },
  });

  if (approval.slackChannel && approval.slackTs) {
    const cfg = await getSlackConfig(approval.workspaceId);
    if (cfg) {
      const card = buildResolvedCard(
        { title: approval.title, body: approval.body, kind: approval.kind as ApprovalKindStr },
        { status: d.status, responseText: d.responseText, responder: approval.respondedBy, at: approval.respondedAt },
      );
      await slackCall(cfg.token, "chat.update", { channel: approval.slackChannel, ts: approval.slackTs, text: card.text, attachments: card.attachments });
    }
  }
}
