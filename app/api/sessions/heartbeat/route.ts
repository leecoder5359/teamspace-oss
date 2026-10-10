import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { heartbeat } from "@/lib/liveSessions";

export const runtime = "nodejs";

// POST /api/sessions/heartbeat { sessionId, cwd?, branch?, repo?, worktree? } → 세션 마지막 활동 갱신(editor+ 토큰).
// PostToolUse 훅(teamspace-project-context.mjs)이 세션당 10분에 한 번 fire-and-forget 으로 부른다.
// 행이 없으면 만들고, 끝난 것으로 표시된 세션이 다시 뛰면 active 로 되살린다. agentName = 호출 토큰 이름.
export async function POST(req: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const row = await heartbeat(guard, body);
  if (!row) return NextResponse.json({ error: "sessionId 필요" }, { status: 400 });
  return NextResponse.json({ ok: true, id: row.id, lastSeenAt: row.lastSeenAt });
}
