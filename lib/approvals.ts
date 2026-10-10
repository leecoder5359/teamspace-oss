// 승인 요청 IO — DB(prisma)·Slack 네트워크. 순수 부분(카드 구성·요약·포맷·재결정 오류 해석)은
// lib/approvals.pure.ts 로 분리했고, 아래 re-export 로 기존 import 경로(@/lib/approvals)를 유지한다.
import { prisma } from "@/lib/prisma";
import { getSlackConfig } from "@/lib/slack";
import { log } from "@/lib/log";
import {
  buildApprovalCard,
  buildResolvedCard,
  type ApprovalKindStr,
  type ApprovalStatusStr,
} from "./approvals.pure";

export * from "./approvals.pure";

const SLACK = "https://slack.com/api";

// ── 발송 / 결정 적용 (DB + Slack 네트워크) ───────────────────────────────
async function slackCall(token: string, method: string, body: Record<string, unknown>) {
  const res = await fetch(`${SLACK}/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  // 슬랙은 실패도 HTTP 200 + { ok:false, error } 로 준다 — 삼키면 카드가 안 바뀌어도 아무도 모른다
  if (!json?.ok) log.warn("slack.call_failed", { msg: `슬랙 ${method} 실패`, method, error: json?.error ?? null, status: res.status });
  return json;
}

/** 승인 요청 생성 + 슬랙 인터랙티브 메시지 발송. */
export async function sendApproval(
  workspaceId: string,
  args: { title: string; body: string; channel?: string; kind?: ApprovalKindStr; highRisk?: boolean; createdBy?: string; projectId?: string },
): Promise<{ id: string; sent: boolean; error?: string }> {
  const KINDS: ApprovalKindStr[] = ["general", "status", "triage", "doc", "project", "deploy"];
  // 이 워크스페이스 소속인 것만 인정한다. 종전엔 넘어온 값을 그대로 저장해
  // 없는 프로젝트 id 가 남았고(Approval.projectId 는 FK 도 없다) 조용히 무의미했다.
  const validProjectId = args.projectId
    ? (await prisma.project.findFirst({ where: { id: args.projectId, workspaceId }, select: { id: true } }))?.id ?? null
    : null;
  const approval = await prisma.approval.create({
    data: {
      workspaceId,
      title: args.title,
      body: args.body,
      kind: KINDS.includes(args.kind as ApprovalKindStr) ? (args.kind as ApprovalKindStr) : "general",
      highRisk: !!args.highRisk,
      ...(args.createdBy != null ? { createdBy: args.createdBy } : {}),
      // projectId 는 호출부에서 넘어온 그대로였다 — 없는/남의 프로젝트여도 그대로
      // 저장돼 조용히 무의미한 값이 남았다(D5 클러스터). 소속을 확인한 것만 넣는다.
      ...(validProjectId != null ? { projectId: validProjectId } : {}),
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


/**
 * 결정을 DB 에 기록한다(빠름). 카드 갱신(chat.update)은 refreshDecisionCard 로 분리 —
 * 슬랙 인터랙션은 3초 안에 응답해야 해서, 라우트는 기록만 기다리고 카드 갱신은 응답 뒤(after)에 한다.
 */
export async function recordDecision(
  approvalId: string,
  d: { status: ApprovalStatusStr; responseText?: string; userId?: string },
) {
  // 재결정 가드(W8 agent-9): pending 이 아닌 승인은 어떤 경로(앱·슬랙 버튼)로도 뒤집을 수 없다
  const current = await prisma.approval.findUnique({ where: { id: approvalId }, select: { status: true } });
  if (!current) throw new Error("approval not found");
  if (current.status !== "pending") {
    throw new Error(`already_decided:${current.status}`);
  }
  const now = new Date();
  const updated = await prisma.approval.update({
    where: { id: approvalId },
    data: {
      status: d.status,
      responseText: d.responseText ?? null,
      respondedBy: d.userId ?? null,
      respondedAt: now,
    },
  });
  // 결정이 끝난 승인 요청 알림은 읽음으로 — 안 하면 인박스 배지가 영영 안 줄어든다(B3).
  // 여기(기록 성공 뒤)에 두면 앱 PATCH(applyDecision)·슬랙 버튼/모달(recordDecision 직접) 둘 다 탄다.
  // 링크에 approvalId 가 실린 알림만 잡힌다(신규부터) — 그 전 알림은 14일 자동 읽음이 정리한다.
  // 베스트에포트: 실패해도 결정은 이미 기록됐다(슬랙 3초 응답을 깨지 않는다).
  await prisma.notification
    .updateMany({
      where: { workspaceId: updated.workspaceId, type: "approval", readAt: null, link: { contains: approvalId } },
      data: { readAt: now },
    })
    .catch((e) => log.warn("approvals.notification_read_failed", { msg: "승인 알림 읽음 처리 실패", approvalId, err: e }));
  return updated;
}

/** 기록된 결정으로 슬랙 카드를 결과 카드로 바꾼다(실패는 로그만). */
export async function refreshDecisionCard(approval: Awaited<ReturnType<typeof recordDecision>>): Promise<void> {
  if (!approval.slackChannel || !approval.slackTs) return;
  const cfg = await getSlackConfig(approval.workspaceId);
  if (!cfg) return;
  const card = buildResolvedCard(
    { title: approval.title, body: approval.body, kind: approval.kind as ApprovalKindStr },
    { status: approval.status as ApprovalStatusStr, responseText: approval.responseText ?? undefined, responder: approval.respondedBy, at: approval.respondedAt },
  );
  await slackCall(cfg.token, "chat.update", { channel: approval.slackChannel, ts: approval.slackTs, text: card.text, attachments: card.attachments });
}

export async function applyDecision(
  approvalId: string,
  d: { status: ApprovalStatusStr; responseText?: string; userId?: string },
): Promise<void> {
  await refreshDecisionCard(await recordDecision(approvalId, d));
}

