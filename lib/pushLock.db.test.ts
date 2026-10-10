import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * 푸시·배포 잠금 + 라이브 세션 보드(Console 4) — 실제 Postgres 통합 테스트. 전용 DB 가 주어질 때만 돈다:
 *   PUSH_LOCK_TEST_DATABASE_URL=postgresql://…/<전용 DB> pnpm vitest run lib/pushLock.db.test.ts
 * (운영/개발 DB 를 가리키지 말 것 — 데이터를 만들고 지운다.)
 */
const DB = process.env.PUSH_LOCK_TEST_DATABASE_URL;

type C = { workspaceId: string; userId: string; role: "admin" | "editor"; actor: { type: "user" | "agent"; id: string; name: string } };

describe.skipIf(!DB)("푸시 잠금·라이브 세션(실DB)", () => {
  let lock: typeof import("./pushLock");
  let live: typeof import("./liveSessions");
  let prisma: typeof import("@/lib/prisma").prisma;
  let ws: { id: string };
  let a: C; // 에이전트 A (토큰 mac-mini)
  let b: C; // 에이전트 B (토큰 laptop)
  let admin: C; // 사람 관리자(로그인 세션)
  let adminAgent: C; // 관리자 역할 토큰 — 강제 해제는 못 한다
  const stamp = Date.now();
  const t0 = new Date("2026-10-09T10:00:00Z");
  const min = (m: number) => new Date(t0.getTime() + m * 60000);

  beforeAll(async () => {
    process.env.DATABASE_URL = DB;
    delete process.env.AUTH_SLACK_BOT_TOKEN;
    ({ prisma } = await import("@/lib/prisma"));
    lock = await import("./pushLock");
    live = await import("./liveSessions");
    ws = await prisma.workspace.create({ data: { name: `pushlock-test-${stamp}` } });
    const mk = async (name: string, role: "admin" | "editor", type: "user" | "agent"): Promise<C> => {
      const u = await prisma.user.create({ data: { email: `${name}-${stamp}@pushlock.test`, name } });
      await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId: u.id, role, status: "active" } });
      return { workspaceId: ws.id, userId: u.id, role, actor: { type, id: u.id, name } };
    };
    a = await mk("mac-mini", "editor", "agent");
    b = await mk("laptop", "editor", "agent");
    admin = await mk("관리자", "admin", "user");
    adminAgent = await mk("admin-bot", "admin", "agent");
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.notification.deleteMany({ where: { workspaceId: ws.id } });
    await prisma.activity.deleteMany({ where: { workspaceId: ws.id } });
    await prisma.workspace.deleteMany({ where: { name: { startsWith: "pushlock-test-" } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: "@pushlock.test" } } });
    await prisma.$disconnect();
  });

  it("잡기 → 같은 보유자는 연장 → 다른 보유자는 409(보유자·메모·나이·만료)", async () => {
    const r1 = await lock.takeLock(a, "banjang/develop", { note: "CI 대기", session: "sa", branch: "develop", cwd: "/w/banjang" }, t0);
    expect(r1.result).toBe("taken");
    expect(r1.lock).toMatchObject({ holderName: "mac-mini", remainingMin: 30, mine: true, note: "CI 대기" });

    const r2 = await lock.takeLock(a, "banjang/develop", { ttlMinutes: 60, session: "sa" }, min(10));
    expect(r2.result).toBe("refreshed");
    expect(r2.lock).toMatchObject({ ageMin: 10, remainingMin: 60, note: "CI 대기" }); // takenAt 그대로, 메모 유지

    await expect(lock.takeLock(b, "banjang/develop", {}, min(20))).rejects.toMatchObject({
      status: 409,
      extra: { conflict: true, lock: expect.objectContaining({ holderName: "mac-mini", note: "CI 대기", ageMin: 20, remainingMin: 50 }) },
    });
    // 같은 토큰이라도 다른 Claude 세션이면 남이다
    await expect(lock.takeLock(a, "banjang/develop", { session: "sa-other" }, min(20))).rejects.toMatchObject({ status: 409 });

    const act = await prisma.activity.findMany({ where: { workspaceId: ws.id, targetType: "lock" } });
    expect(act.map((x) => x.verb)).toEqual(["locked"]); // 연장은 피드에 남기지 않는다
  });

  it("만료되면 빈 잠금 — 다른 보유자가 인수(takenAt 새로)", async () => {
    await lock.takeLock(a, "teamspace/main", { ttlMinutes: 5 }, t0);
    const r = await lock.takeLock(b, "teamspace/main", { note: "배포" }, min(6));
    expect(r.result).toBe("taken");
    expect(r.lock).toMatchObject({ holderName: "laptop", ageMin: 0, note: "배포" });
  });

  it("동시에 잡으면 한쪽만 이긴다", async () => {
    const rs = await Promise.allSettled([
      lock.takeLock(a, "deploy:race", {}, t0),
      lock.takeLock(b, "deploy:race", {}, t0),
      lock.takeLock(b, "deploy:race", { session: "x" }, t0),
    ]);
    const ok = rs.filter((r) => r.status === "fulfilled");
    const holders = new Set(ok.map((r) => (r as PromiseFulfilledResult<{ lock: { holderName: string } }>).value.lock.holderName));
    expect(holders.size).toBe(1);
    for (const r of rs.filter((r) => r.status === "rejected")) expect((r as PromiseRejectedResult).reason.status).toBe(409);
  });

  it("검증: 이름 형식·TTL 상한", async () => {
    await expect(lock.takeLock(a, "Bad Name", {}, t0)).rejects.toMatchObject({ status: 400 });
    await expect(lock.takeLock(a, "ok/name", { ttlMinutes: 241 }, t0)).rejects.toMatchObject({ status: 400 });
  });

  it("연장: 보유자만, 비어 있으면 404, 남의 것이면 409", async () => {
    await lock.takeLock(a, "ext/x", {}, t0);
    expect((await lock.extendLock(a, "ext/x", { ttlMinutes: 120 }, min(5))).lock.remainingMin).toBe(120);
    await expect(lock.extendLock(b, "ext/x", {}, min(5))).rejects.toMatchObject({ status: 409 });
    await expect(lock.extendLock(a, "ext/none", {}, min(5))).rejects.toMatchObject({ status: 404 });
  });

  it("해제: 남은 403, 관리자 토큰도 강제 불가, 관리자 로그인 세션은 강제 해제 + 보유자 알림", async () => {
    await lock.takeLock(a, "rel/x", {}, t0);
    await expect(lock.releaseLock(b, "rel/x", {}, min(1))).rejects.toMatchObject({ status: 403 });
    await expect(lock.releaseLock(adminAgent, "rel/x", { force: true }, min(1))).rejects.toMatchObject({ status: 403 });
    expect(await lock.releaseLock(admin, "rel/x", { force: true }, min(1))).toMatchObject({ released: true, forced: true });
    const n = await prisma.notification.findFirst({ where: { workspaceId: ws.id, userId: a.userId, type: "lock" } });
    expect(n?.title).toMatch(/강제 해제/);
    expect((await lock.getLock(a, "rel/x", null, min(2))).lock).toBeNull();

    await lock.takeLock(a, "rel/y", {}, t0);
    expect(await lock.releaseLock(a, "rel/y", {}, min(1))).toMatchObject({ released: true });
    expect(await lock.releaseLock(a, "rel/y", {}, min(1))).toMatchObject({ released: false });
    // 해제 후 바로 남이 잡을 수 있다
    expect((await lock.takeLock(b, "rel/y", {}, min(2))).result).toBe("taken");
  });

  it("푸시 경고 알림: 보유자 인박스 1건, 5분 안 재호출은 throttled, 보유자 본인·빈 잠금은 안 보냄", async () => {
    await lock.takeLock(a, "notify/develop", { session: "sa" }, t0);
    const before = await prisma.notification.count({ where: { workspaceId: ws.id, userId: a.userId } });
    expect(await lock.notifyLockHolder(b, "notify/develop", { branch: "develop" }, min(1))).toMatchObject({ notified: true, holderName: "mac-mini" });
    expect(await lock.notifyLockHolder(b, "notify/develop", {}, min(3))).toMatchObject({ notified: false, reason: "throttled" });
    expect(await lock.notifyLockHolder(b, "notify/develop", {}, min(7))).toMatchObject({ notified: true });
    expect(await lock.notifyLockHolder(a, "notify/develop", { session: "sa" }, min(8))).toMatchObject({ notified: false, reason: "mine" });
    expect(await lock.notifyLockHolder(b, "notify/none", {}, min(8))).toMatchObject({ notified: false, reason: "free" });
    expect(await prisma.notification.count({ where: { workspaceId: ws.id, userId: a.userId } })).toBe(before + 2);
    expect(await prisma.activity.count({ where: { workspaceId: ws.id, verb: "push_warned" } })).toBe(2);
  });

  it("목록은 살아 있는 잠금만, mine 은 호출자 기준", async () => {
    const ls = await lock.listLocks(b, null, min(1));
    const names = ls.map((l) => l.name);
    expect(names).toContain("banjang/develop");
    expect(names).not.toContain("rel/x");
    expect(ls.find((l) => l.name === "teamspace/main")?.mine).toBe(true); // b 가 인수한 잠금
    expect((await lock.listLocks(a, null, min(7))).find((l) => l.name === "teamspace/main")?.mine).toBe(false);
    expect((await lock.listLocks(a, null, min(60))).map((l) => l.name)).not.toContain("teamspace/main"); // 만료 → 목록에서 빠짐
  });

  it("라이브 세션: 하트비트·인입 필드·2시간 창·진행 중 태스크·잠금 터치", async () => {
    const now = new Date();
    await live.heartbeat(a, { sessionId: "sess-a", cwd: "/w/banjang-wt", branch: "feat/x", repo: "banjang", worktree: "/w/banjang-wt" }, now);
    await prisma.claudeSession.create({ data: { workspaceId: ws.id, externalId: "sess-old", status: "active", startedAt: new Date(now.getTime() - 5 * 3600000), lastSeenAt: new Date(now.getTime() - 3 * 3600000) } });
    await prisma.claudeSession.create({ data: { workspaceId: ws.id, externalId: "sess-ended", status: "ended", lastSeenAt: now } });
    await prisma.claudeSession.create({ data: { workspaceId: ws.id, externalId: "sess-new", status: "active", agentName: "laptop" } }); // lastSeen 없음 → 시작 기준

    const { createTaskDatabase } = await import("./taskdb");
    const board = await createTaskDatabase(ws.id, admin.userId, "보드", null);
    const props = await prisma.dbProperty.findMany({ where: { databasePageId: board.id } });
    const title = props.find((p) => p.name === "이름")!;
    const status = props.find((p) => p.name === "상태")!;
    const assignee = props.find((p) => p.name === "담당자")!;
    const opts = (status.config as { options: { id: string; name: string }[] }).options;
    const doing = opts.find((o) => o.name === "진행 중")!.id;
    const todo = opts.find((o) => o.name === "할 일")!.id;
    await prisma.dbRow.createMany({
      data: [
        { databasePageId: board.id, position: 0, props: { [title.id]: "도면 가져오기", [status.id]: doing, [assignee.id]: "mac-mini" } },
        { databasePageId: board.id, position: 1, props: { [title.id]: "아직 안 함", [status.id]: todo, [assignee.id]: "mac-mini" } },
        { databasePageId: board.id, position: 2, props: { [title.id]: "남의 일", [status.id]: doing, [assignee.id]: "someone" } },
      ],
    });

    const r = await live.liveBoard(admin, now);
    const ids = r.sessions.map((s) => s.externalId);
    expect(ids).toEqual(expect.arrayContaining(["sess-a", "sess-new"]));
    expect(ids).not.toContain("sess-old");
    expect(ids).not.toContain("sess-ended");
    const sa = r.sessions.find((s) => s.externalId === "sess-a")!;
    expect(sa).toMatchObject({ repo: "banjang", branch: "feat/x", worktree: "banjang-wt", agentName: "mac-mini" });
    expect(sa.tasks.map((t) => t.title)).toEqual(["도면 가져오기"]);
    expect(r.locks.map((l) => l.name)).toContain("banjang/develop");

    // 끝난 세션도 하트비트가 오면 되살아난다(resume)
    await live.heartbeat(b, { sessionId: "sess-ended" }, now);
    expect((await live.liveBoard(admin, now)).sessions.map((s) => s.externalId)).toContain("sess-ended");

    // 잠금 CLI 호출이 세션 마지막 활동을 갱신
    const later = new Date(now.getTime() + 60000);
    await lock.touchSession(ws.id, "sess-a", "mac-mini", later);
    expect((await prisma.claudeSession.findFirst({ where: { workspaceId: ws.id, externalId: "sess-a" } }))?.lastSeenAt?.getTime()).toBe(later.getTime());
  });
});
