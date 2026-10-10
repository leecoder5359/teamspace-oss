import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { listLocks } from "@/lib/pushLock";
import { lockErrorResponse } from "@/lib/pushLockRoute";

export const runtime = "nodejs";

// GET /api/locks[?session=<claude 세션 id>] → { locks: [...] } 살아 있는 푸시·배포 잠금(만료·해제 제외). editor+.
// 각 잠금의 mine 은 호출자(토큰 이름 + 세션)가 보유자인지.
export async function GET(req: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  try {
    const session = new URL(req.url).searchParams.get("session");
    return NextResponse.json({ locks: await listLocks(guard, session) });
  } catch (e) {
    return lockErrorResponse(e);
  }
}
