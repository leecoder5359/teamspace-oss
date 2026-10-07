import { NextResponse, after } from "next/server";
import { getDefaultContext } from "@/lib/workspace";
import { getSlackConfig } from "@/lib/slack";
import { verifySlackSignature } from "@/lib/slackSign";
import { alreadyDecidedModalResponse, buildReasonModalView, parseAlreadyDecided, recordDecision, refreshDecisionCard } from "@/lib/approvals";
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

    // 슬랙은 3초 안에 응답이 없으면 실패로 보여 준다 — DB 기록만 기다리고 카드 갱신(chat.update)은 응답 뒤에.
    if (action.action_id === "approve") {
      try {
        const approval = await recordDecision(approvalId, { status: "approved", userId });
        after(() => refreshDecisionCard(approval).catch((e) => console.warn("[slack] 카드 갱신 실패", e)));
      } catch (e) {
        if (!parseAlreadyDecided(e)) throw e; // 이미 처리됨: 버튼 재클릭은 조용히 무시(카드가 곧 결과로 바뀐다)
      }
      return NextResponse.json({});
    }

    // reject / additional → 입력 모달 열기. trigger_id 는 3초 안에만 유효하다.
    const kind = action.action_id === "reject" ? "reject" : "additional";
    const cfg = await getSlackConfig(workspaceId);
    if (cfg && payload.trigger_id) {
      const ap = await prisma.approval.findUnique({ where: { id: approvalId }, select: { title: true } });
      const res = await fetch(`${SLACK}/views.open`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ trigger_id: payload.trigger_id, view: buildReasonModalView({ approvalId, kind, title: ap?.title ?? "" }) }),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!json?.ok) console.warn(`[slack] views.open 실패: ${json?.error ?? res.status}`);
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
      try {
        const approval = await recordDecision(meta.approvalId, {
          status: meta.kind === "reject" ? "rejected" : "additional",
          responseText: value?.trim() || undefined,
          userId,
        });
        after(() => refreshDecisionCard(approval).catch((e) => console.warn("[slack] 카드 갱신 실패", e)));
      } catch (e) {
        const status = parseAlreadyDecided(e);
        if (!status) throw e;
        // 앞선 제출이 이미 저장됐다 — 500 대신 모달 안에 알린다(재제출 루프 방지)
        return NextResponse.json(alreadyDecidedModalResponse(status));
      }
    }
    return NextResponse.json({ response_action: "clear" });
  }

  return NextResponse.json({});
}
