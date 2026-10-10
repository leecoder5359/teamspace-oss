import { prisma } from "@/lib/prisma";
import { pushNotification, recordActivity } from "@/lib/activity";
import type { Ctx } from "@/lib/workspace";
import { DEFAULT_TTL_MIN, MAX_TTL_MIN, lockNameError } from "@/lib/pushLockRules";

/**
 * 공유 브랜치 푸시·배포 예약 잠금(Console 4). 결정: 예약 잠금 + pre-push **경고**(푸시는 절대 막지 않는다).
 *
 * - 이름은 자유 형식 자원 키(`banjang/develop`·`teamspace/main`·`deploy:teamspace`).
 * - 이름당 한 행. 만료(expiresAt≤now)·해제(releasedAt)면 빈 잠금 → 누구나 잡을 수 있다.
 * - 잡기는 조건부 updateMany 두 번(① 내 것이면 연장 ② 비어 있으면 인수)이고, 행이 없을 때만 create —
 *   (workspaceId,name) unique 라 동시 create 는 한쪽만 성공하고 진 쪽은 다시 ①② 를 탄다. 경쟁에서 진 요청은 409.
 * - 보유자 = 에이전트 토큰 이름(+ 토큰의 시스템 User). Claude 세션 id 가 양쪽에 있으면 세션까지 같아야 같은 보유자다
 *   (같은 토큰을 쓰는 다른 세션의 푸시도 경고 대상). 한쪽이라도 세션이 없으면 이름으로만 비교한다.
 */

export { LOCK_NAME_RE, DEFAULT_TTL_MIN, MAX_TTL_MIN, lockNameError, parseTtlFlag } from "@/lib/pushLockRules";
export const NOTIFY_THROTTLE_MS = 5 * 60 * 1000;

/** 라우트 파라미터 → 잠금 이름. 슬래시가 든 이름은 CLI·훅이 encodeURIComponent 로 한 세그먼트에 담아 보낸다. */
export function lockNameFromParam(raw: string): string {
  try {
    return raw.includes("%") ? decodeURIComponent(raw) : raw;
  } catch {
    return raw;
  }
}

export class LockError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** TTL(분) 검증. undefined → 기본 30분. 정수 1~240 이 아니면 LockError(400). */
export function ttlMinutesOf(v: unknown): number {
  if (v === undefined || v === null || v === "") return DEFAULT_TTL_MIN;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_TTL_MIN) throw new LockError(400, `유지 시간은 1~${MAX_TTL_MIN}분(최대 4시간)입니다.`);
  return n;
}

export type LockRow = {
  id: string;
  name: string;
  holderName: string;
  holderUserId: string | null;
  holderSession: string | null;
  cwd: string | null;
  branch: string | null;
  note: string | null;
  takenAt: Date;
  expiresAt: Date;
  releasedAt: Date | null;
};

export type Me = { name: string; userId: string; session?: string | null };

export function isActive(l: Pick<LockRow, "releasedAt" | "expiresAt">, now: Date): boolean {
  return !l.releasedAt && l.expiresAt.getTime() > now.getTime();
}

export function isSameHolder(l: Pick<LockRow, "holderName" | "holderUserId" | "holderSession">, me: Me): boolean {
  if (l.holderName !== me.name) return false;
  if (l.holderUserId && l.holderUserId !== me.userId) return false;
  if (l.holderSession && me.session && l.holderSession !== me.session) return false;
  return true;
}

export function lockView(l: LockRow, now: Date, me?: Me) {
  const active = isActive(l, now);
  return {
    name: l.name,
    active,
    holderName: l.holderName,
    holderSession: l.holderSession,
    cwd: l.cwd,
    branch: l.branch,
    note: l.note,
    takenAt: l.takenAt.toISOString(),
    expiresAt: l.expiresAt.toISOString(),
    ageMin: Math.max(0, Math.floor((now.getTime() - l.takenAt.getTime()) / 60000)),
    remainingMin: active ? Math.ceil((l.expiresAt.getTime() - now.getTime()) / 60000) : 0,
    mine: me ? active && isSameHolder(l, me) : false,
  };
}
export type LockView = ReturnType<typeof lockView>;

export function meOf(ctx: Ctx, session?: string | null): Me {
  return { name: ctx.actor.name, userId: ctx.userId, session: session?.trim() || null };
}

/** "내 잠금(살아 있음)" 조건 — isSameHolder 와 같은 규칙을 where 로. */
function mineWhere(workspaceId: string, name: string, me: Me, now: Date) {
  return {
    workspaceId,
    name,
    releasedAt: null,
    expiresAt: { gt: now },
    holderName: me.name,
    OR: [{ holderUserId: null }, { holderUserId: me.userId }],
    ...(me.session ? { AND: [{ OR: [{ holderSession: null }, { holderSession: me.session }] }] } : {}),
  };
}
function freeWhere(workspaceId: string, name: string, now: Date) {
  return { workspaceId, name, OR: [{ releasedAt: { not: null } }, { expiresAt: { lte: now } }] };
}

function checkName(name: string) {
  const e = lockNameError(name);
  if (e) throw new LockError(400, e);
}

async function conflict(workspaceId: string, name: string, now: Date, me: Me): Promise<never> {
  const cur = await prisma.pushLock.findUnique({ where: { workspaceId_name: { workspaceId, name } } });
  const v = cur ? lockView(cur, now, me) : null;
  throw new LockError(
    409,
    v ? `'${name}' 은 ${v.holderName} 가 잡고 있습니다${v.note ? ` (메모: ${v.note})` : ""} — ${v.ageMin}분 전, ${v.remainingMin}분 뒤 만료.` : `'${name}' 을 잡지 못했습니다(경쟁).`,
    { conflict: true, lock: v },
  );
}

export type TakeInput = { ttlMinutes?: unknown; note?: string | null; session?: string | null; cwd?: string | null; branch?: string | null };

/** 잡기: 내 것이면 연장(refreshed), 비어 있으면 인수(taken), 남의 것이면 409. */
export async function takeLock(ctx: Ctx, name: string, input: TakeInput, now = new Date()) {
  checkName(name);
  const ttl = ttlMinutesOf(input.ttlMinutes);
  const me = meOf(ctx, input.session);
  const expiresAt = new Date(now.getTime() + ttl * 60000);
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 300) || null : null;
  const cwd = input.cwd?.trim() || null;
  const branch = input.branch?.trim() || null;
  const { workspaceId } = ctx;

  for (let attempt = 0; attempt < 2; attempt++) {
    const refreshed = await prisma.pushLock.updateMany({
      where: mineWhere(workspaceId, name, me, now),
      data: {
        expiresAt,
        ...(note !== null ? { note } : {}),
        ...(me.session ? { holderSession: me.session } : {}),
        ...(cwd ? { cwd } : {}),
        ...(branch ? { branch } : {}),
      },
    });
    if (refreshed.count > 0) return finish("refreshed");

    const fresh = { holderName: me.name, holderUserId: me.userId, holderSession: me.session, cwd, branch, note, takenAt: now, expiresAt, releasedAt: null, lastNotifiedAt: null };
    const took = await prisma.pushLock.updateMany({ where: freeWhere(workspaceId, name, now), data: fresh });
    if (took.count > 0) return finish("taken");

    const exists = await prisma.pushLock.findUnique({ where: { workspaceId_name: { workspaceId, name } }, select: { id: true } });
    if (exists) return conflict(workspaceId, name, now, me);
    try {
      await prisma.pushLock.create({ data: { workspaceId, name, ...fresh } });
      return finish("taken");
    } catch (e) {
      if ((e as { code?: string }).code !== "P2002") throw e;
      // 동시에 누가 먼저 만들었다 → 한 번 더 ①② (내 것일 수는 없으니 대개 409)
    }
  }
  return conflict(workspaceId, name, now, me);

  async function finish(result: "taken" | "refreshed") {
    const row = await prisma.pushLock.findUniqueOrThrow({ where: { workspaceId_name: { workspaceId, name } } });
    if (result === "taken") recordActivity(ctx, "locked", "lock", note ? `${name} — ${note}` : name, row.id);
    return { result, lock: lockView(row, now, me) };
  }
}

/** 연장: 내 잠금만. 비어 있으면 404, 남의 것이면 409. */
export async function extendLock(ctx: Ctx, name: string, input: { ttlMinutes?: unknown; session?: string | null }, now = new Date()) {
  checkName(name);
  const ttl = ttlMinutesOf(input.ttlMinutes);
  const me = meOf(ctx, input.session);
  const r = await prisma.pushLock.updateMany({
    where: mineWhere(ctx.workspaceId, name, me, now),
    data: { expiresAt: new Date(now.getTime() + ttl * 60000) },
  });
  if (r.count === 0) {
    const cur = await prisma.pushLock.findUnique({ where: { workspaceId_name: { workspaceId: ctx.workspaceId, name } } });
    if (!cur || !isActive(cur, now)) throw new LockError(404, `'${name}' 은 비어 있습니다 — 먼저 잡으세요(lock take).`);
    return conflict(ctx.workspaceId, name, now, me);
  }
  const row = await prisma.pushLock.findUniqueOrThrow({ where: { workspaceId_name: { workspaceId: ctx.workspaceId, name } } });
  return { lock: lockView(row, now, me) };
}

/** 해제: 보유자만. 관리자 로그인 세션은 force 로 강제 해제(보유자에게 알림). 이미 비어 있으면 released:false. */
export async function releaseLock(ctx: Ctx, name: string, input: { session?: string | null; force?: boolean }, now = new Date()) {
  checkName(name);
  const me = meOf(ctx, input.session);
  const mine = await prisma.pushLock.updateMany({ where: mineWhere(ctx.workspaceId, name, me, now), data: { releasedAt: now } });
  if (mine.count > 0) {
    recordActivity(ctx, "released", "lock", name);
    return { released: true, forced: false };
  }
  const cur = await prisma.pushLock.findUnique({ where: { workspaceId_name: { workspaceId: ctx.workspaceId, name } } });
  if (!cur || !isActive(cur, now)) return { released: false, forced: false, reason: "이미 비어 있습니다." };
  if (!input.force) {
    throw new LockError(403, `'${name}' 은 ${cur.holderName} 의 잠금입니다 — 보유자만 해제할 수 있습니다(관리자는 설정 화면에서 강제 해제).`, { lock: lockView(cur, now, me) });
  }
  if (ctx.actor.type !== "user" || ctx.role !== "admin") throw new LockError(403, "강제 해제는 관리자 로그인 세션에서만 할 수 있습니다.");
  const r = await prisma.pushLock.updateMany({ where: { id: cur.id, releasedAt: null }, data: { releasedAt: now } });
  if (r.count > 0) {
    recordActivity(ctx, "force_released", "lock", `${name} (보유: ${cur.holderName})`, cur.id);
    if (cur.holderUserId) await pushNotification(ctx.workspaceId, [cur.holderUserId], "lock", `${ctx.actor.name} 님이 잠금 '${name}' 을 강제 해제했습니다.`, "/settings", ctx.userId);
  }
  return { released: r.count > 0, forced: true };
}

export async function getLock(ctx: Ctx, name: string, session?: string | null, now = new Date()) {
  checkName(name);
  const row = await prisma.pushLock.findUnique({ where: { workspaceId_name: { workspaceId: ctx.workspaceId, name } } });
  return { lock: row && isActive(row, now) ? lockView(row, now, meOf(ctx, session)) : null };
}

/** 살아 있는 잠금 목록(만료·해제는 빠진다). */
export async function listLocks(ctx: Ctx, session?: string | null, now = new Date()) {
  const rows = await prisma.pushLock.findMany({
    where: { workspaceId: ctx.workspaceId, releasedAt: null, expiresAt: { gt: now } },
    orderBy: { name: "asc" },
  });
  const me = meOf(ctx, session);
  return rows.map((r) => lockView(r, now, me));
}

/**
 * pre-push 경고 알림: 남이 잡은 살아 있는 잠금에 푸시가 일어났음을 보유자 인박스에 남긴다.
 * 잠금당 5분 1회(lastNotifiedAt 조건부 갱신이라 동시 호출에도 한 번만).
 */
export async function notifyLockHolder(
  ctx: Ctx,
  name: string,
  input: { session?: string | null; branch?: string | null; cwd?: string | null },
  now = new Date(),
) {
  checkName(name);
  const me = meOf(ctx, input.session);
  const cur = await prisma.pushLock.findUnique({ where: { workspaceId_name: { workspaceId: ctx.workspaceId, name } } });
  if (!cur || !isActive(cur, now)) return { notified: false, reason: "free" as const };
  if (isSameHolder(cur, me)) return { notified: false, reason: "mine" as const };
  const gate = await prisma.pushLock.updateMany({
    where: { id: cur.id, OR: [{ lastNotifiedAt: null }, { lastNotifiedAt: { lt: new Date(now.getTime() - NOTIFY_THROTTLE_MS) } }] },
    data: { lastNotifiedAt: now },
  });
  if (gate.count === 0) return { notified: false, reason: "throttled" as const };
  const where = [input.branch?.trim(), input.cwd?.trim()].filter(Boolean).join(" · ");
  if (cur.holderUserId) {
    await pushNotification(
      ctx.workspaceId,
      [cur.holderUserId],
      "lock",
      `${me.name} 이(가) 잠금 '${name}' 대상에 푸시했습니다${where ? ` (${where})` : ""}. 잠금은 그대로입니다.`,
      "/settings",
    );
  }
  recordActivity(ctx, "push_warned", "lock", `${name} (보유: ${cur.holderName})`, cur.id);
  return { notified: true, reason: "sent" as const, holderName: cur.holderName };
}

/** 세션 마지막 활동 갱신(잠금 CLI 호출이 곧 그 세션이 살아 있다는 신호). 세션이 없으면 아무것도 안 한다. */
export async function touchSession(workspaceId: string, session: string | null | undefined, agentName: string, now = new Date()) {
  const externalId = session?.trim();
  if (!externalId) return;
  await prisma.claudeSession
    .updateMany({ where: { workspaceId, externalId }, data: { lastSeenAt: now, agentName } })
    .catch(() => {});
}
