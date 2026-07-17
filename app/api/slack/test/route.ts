import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { postMessage } from "@/lib/slack";

export const runtime = "nodejs";

// POST /api/slack/test → 테스트 메시지 발송
export async function POST(request: Request) {
  const guard = await requireCtx("admin");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const body = (await request.json().catch(() => ({}))) as { channel?: string; text?: string };
  const text = body.text?.trim() || "✅ TeamSpace 슬랙 연동 테스트 메시지입니다.";
  const result = await postMessage(workspaceId, { channel: body.channel, text, kind: "test" });
  return NextResponse.json(result);
}
