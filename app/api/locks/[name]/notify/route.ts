import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { lockNameFromParam, notifyLockHolder } from "@/lib/pushLock";
import { lockErrorResponse } from "@/lib/pushLockRoute";

export const runtime = "nodejs";

// POST /api/locks/<name>/notify { session?, branch?, cwd? } → pre-push 훅이 남의 잠금 위로 푸시할 때 부른다.
// 보유자(토큰의 시스템 User) 인박스에 알림 + 활동 피드 기록. 잠금당 5분에 1번만(그 사이는 throttled).
// 응답: { notified, reason: sent|throttled|mine|free, holderName? }
export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  try {
    const name = lockNameFromParam((await params).name);
    const body = (await req.json().catch(() => ({}))) as { session?: string; branch?: string; cwd?: string };
    return NextResponse.json(await notifyLockHolder(guard, name, { session: body.session, branch: body.branch, cwd: body.cwd }));
  } catch (e) {
    return lockErrorResponse(e);
  }
}
