import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { extendLock, getLock, lockNameFromParam, releaseLock, takeLock, touchSession } from "@/lib/pushLock";
import { lockErrorResponse } from "@/lib/pushLockRoute";

export const runtime = "nodejs";

// 푸시·배포 예약 잠금(Console 4). 이름에 / 가 들어가므로 호출자는 encodeURIComponent 로 한 세그먼트에 담는다.
//   GET    /api/locks/<name>[?session=]                                       → { lock | null } (lock.mine = 호출자가 보유자)
//   POST   /api/locks/<name> { ttlMinutes?, note?, session?, cwd?, branch? }  → 잡기(기본 30분, 최대 240분). 내 것이면 연장, 남의 것이면 409
//   PATCH  /api/locks/<name> { ttlMinutes?, session? }                        → 연장(보유자만)
//   DELETE /api/locks/<name>[?session=&force=1]                               → 해제(보유자만, force=1 은 관리자 로그인 세션)
type P = { params: Promise<{ name: string }> };
type Body = { ttlMinutes?: unknown; note?: string; session?: string; cwd?: string; branch?: string };

export async function GET(req: Request, { params }: P) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  try {
    const name = lockNameFromParam((await params).name);
    return NextResponse.json(await getLock(guard, name, new URL(req.url).searchParams.get("session")));
  } catch (e) {
    return lockErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: P) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  try {
    const name = lockNameFromParam((await params).name);
    const body = (await req.json().catch(() => ({}))) as Body;
    const r = await takeLock(guard, name, { ttlMinutes: body.ttlMinutes, note: body.note, session: body.session, cwd: body.cwd, branch: body.branch });
    await touchSession(guard.workspaceId, body.session, guard.actor.name);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return lockErrorResponse(e);
  }
}

export async function PATCH(req: Request, { params }: P) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  try {
    const name = lockNameFromParam((await params).name);
    const body = (await req.json().catch(() => ({}))) as Body;
    const r = await extendLock(guard, name, { ttlMinutes: body.ttlMinutes, session: body.session });
    await touchSession(guard.workspaceId, body.session, guard.actor.name);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return lockErrorResponse(e);
  }
}

export async function DELETE(req: Request, { params }: P) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  try {
    const name = lockNameFromParam((await params).name);
    const q = new URL(req.url).searchParams;
    const session = q.get("session");
    const r = await releaseLock(guard, name, { session, force: q.get("force") === "1" || q.get("force") === "true" });
    await touchSession(guard.workspaceId, session, guard.actor.name);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return lockErrorResponse(e);
  }
}
