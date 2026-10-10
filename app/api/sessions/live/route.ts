import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { liveBoard } from "@/lib/liveSessions";

export const runtime = "nodejs";

// GET /api/sessions/live → 라이브 세션 보드(Console 4). editor+.
// { windowHours, sessions: [{ id, externalId, repo, branch, worktree, worktreePath, cwd, project, agentName, startedAt, lastSeenAt,
//   tasks: [{ id, title, board, boardTitle }] }], locks: [...] }
// 살아 있음 = status active 이고 마지막 활동(없으면 시작)이 2시간 안. tasks = 그 에이전트 이름이 담당인 '진행 중' 태스크.
export async function GET() {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  return NextResponse.json(await liveBoard(guard));
}
