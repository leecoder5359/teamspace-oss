import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { listChannels } from "@/lib/slack";

export const runtime = "nodejs";

// GET /api/slack/channels → 공개 채널 목록(피커용). channels:read 스코프 없으면 ok:false.
export async function GET() {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const result = await listChannels(workspaceId);
  return NextResponse.json(result);
}
