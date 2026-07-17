import { NextResponse } from "next/server";
import { getDefaultContext } from "@/lib/workspace";
import { getSlackConfig } from "@/lib/slack";
import { verifySlackSignature } from "@/lib/slackSign";
import { applyDecision, buildReasonModalView } from "@/lib/approvals";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const SLACK = "https://slack.com/api";

// POST /api/slack/interactions → 슬랙 인터랙티브 콜백(공개·서명검증 필수)
export async function POST(request: Request) {
  const secret = process.env.AUTH_SLACK_SIGNING_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ error: "AUTH_SLACK_SIGNING_SECRET 미설정" }, { status: 503 });
  }

  const raw = await request.text();
  const sig = request.headers.get("x-slack-signature") ?? "";
  const ts = request.headers.get("x-slack-request-timestamp") ?? "";
  if (!verifySlackSignature(secret, ts, raw, sig)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  // 슬랙은 application/x-www-form-urlencoded 로 payload=<json> 전송
  type SlackPayload = {
    type?: string;
    trigger_id?: string;
    user?: { id?: string };
    actions?: { action_id?: string; value?: string }[];
    view?: {
      private_metadata?: string;
      state?: { values?: { reason?: { value?: { value?: string } } } };
    };
  };
  const params = new URLSearchParams(raw);
  let payload: SlackPayload;
  try {
    payload = JSON.parse(params.get("payload") ?? "{}") as SlackPayload;
  } catch {
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }

  const { workspaceId } = await getDefaultContext(); // 슬랙 서명 자체 인증 경로 — 워크스페이스 스코프 해석은 W8에서 개선

  if (payload.type === "block_actions") {
    const action = payload.actions?.[0];
    const approvalId = action?.value as string | undefined;
    const userId = payload.user?.id as string | undefined;
    if (!action || !approvalId) return NextResponse.json({});

    if (action.action_id === "approve") {
      await applyDecision(approvalId, { status: "approved", userId });
      return NextResponse.json({});
    }

    // reject / additional → 입력 모달 열기
    const kind = action.action_id === "reject" ? "reject" : "additional";
    const cfg = await getSlackConfig(workspaceId);
    if (cfg && payload.trigger_id) {
      const ap = await prisma.approval.findUnique({ where: { id: approvalId } });
      await fetch(`${SLACK}/views.open`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ trigger_id: payload.trigger_id, view: buildReasonModalView({ approvalId, kind, title: ap?.title ?? "" }) }),
      });
    }
    return NextResponse.json({});
  }

  if (payload.type === "view_submission") {
    let meta: { approvalId?: string; kind?: string } = {};
    try {
      meta = JSON.parse(payload.view?.private_metadata ?? "{}");
    } catch {
      /* ignore */
    }
    const value: string | undefined = payload.view?.state?.values?.reason?.value?.value;
    const userId = payload.user?.id as string | undefined;
    if (meta.approvalId) {
      await applyDecision(meta.approvalId, {
        status: meta.kind === "reject" ? "rejected" : "additional",
        responseText: value?.trim() || undefined,
        userId,
      });
    }
    return NextResponse.json({ response_action: "clear" });
  }

  return NextResponse.json({});
}
