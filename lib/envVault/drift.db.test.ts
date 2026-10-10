import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";

/**
 * env 금고 P3(드리프트 기록·syncGroup·메모 변경) — 실제 Postgres 통합 테스트. 전용 DB 가 주어질 때만 돈다:
 *   ENV_VAULT_TEST_DATABASE_URL=postgresql://…/<전용 DB> pnpm vitest run lib/envVault/drift.db.test.ts
 * (운영/개발 DB 를 가리키지 말 것 — 데이터를 만들고 지운다.)
 */
const DB = process.env.ENV_VAULT_TEST_DATABASE_URL;

describe.skipIf(!DB)("env 금고 P3(실DB)", () => {
  let svc: typeof import("./service");
  let push: typeof import("./push");
  let prisma: typeof import("@/lib/prisma").prisma;
  let ws: { id: string };
  let p1: { id: string };
  let p2: { id: string };
  const meta = { viaFunnel: false };
  let human: { workspaceId: string; userId: string; actor: { type: "user"; id: string; name: string } };
  let agent: { workspaceId: string; userId: string; actor: { type: "agent"; id: string; name: string } };

  beforeAll(async () => {
    process.env.DATABASE_URL = DB;
    process.env.ENV_VAULT_KEY = randomBytes(32).toString("base64");
    delete process.env.AUTH_SLACK_BOT_TOKEN;
    ({ prisma } = await import("@/lib/prisma"));
    svc = await import("./service");
    push = await import("./push");
    const stamp = Date.now();
    ws = await prisma.workspace.create({ data: { name: `envdrift-test-${stamp}` } });
    const u = await prisma.user.create({ data: { email: `h-${stamp}@envdrift.test`, name: "사람" } });
    const a = await prisma.user.create({ data: { email: `a-${stamp}@envdrift.test`, name: "봇" } });
    p1 = await prisma.project.create({ data: { workspaceId: ws.id, name: "드리프트1" } });
    p2 = await prisma.project.create({ data: { workspaceId: ws.id, name: "드리프트2" } });
    human = { workspaceId: ws.id, userId: u.id, actor: { type: "user", id: u.id, name: "사람" } };
    agent = { workspaceId: ws.id, userId: a.id, actor: { type: "agent", id: a.id, name: "봇" } };
    await svc.setVar(human, { projectId: p1.id, env: "dev", key: "API_KEY", value: "v1" }, meta);
    await svc.setVar(human, { projectId: p1.id, env: "dev", key: "OTHER", value: "v2" }, meta);
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.workspace.deleteMany({ where: { name: { startsWith: "envdrift-" } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: "@envdrift.test" } } });
    await prisma.$disconnect();
  });

  it("드리프트 기록: 검증 → 저장 → 목록에 대상별·키별 상태, 감사 drift(키 이름만)", async () => {
    const t = await push.createTarget(agent, { projectId: p1.id, env: "dev", kind: "dotenv", config: { path: "/private/tmp/drift/.env" } }, meta);
    await expect(push.recordDrift(agent, t.id, { results: { API_KEY: "present" } }, meta)).rejects.toMatchObject({ status: 400 });
    await expect(push.recordDrift(agent, t.id, { results: { API_KEY: "remote_only" } }, meta)).rejects.toMatchObject({ status: 400 });
    await expect(push.recordDrift(agent, "nope", { results: {} }, meta)).rejects.toMatchObject({ status: 404 });

    const r = await push.recordDrift(agent, t.id, { results: { API_KEY: "match", OTHER: "differs", EXTRA: "remote_only" } }, meta);
    expect(r.counts).toMatchObject({ match: 1, differs: 1, remote_only: 1 });
    expect(r.target.driftIssues).toBe(2);
    expect(r.target.lastDriftAt).toBeInstanceOf(Date);

    const list = await svc.listVars(human, { projectId: p1.id });
    expect(list.targets[0]).toMatchObject({ id: t.id, driftIssues: 2, lastDrift: { API_KEY: "match", OTHER: "differs", EXTRA: "remote_only" } });
    expect(Object.fromEntries(list.vars.map((v) => [v.key, v.drift[t.id]]))).toEqual({ API_KEY: "match", OTHER: "differs" });

    const log = await prisma.envAccessLog.findFirst({ where: { workspaceId: ws.id, action: "drift" } });
    expect(log).toMatchObject({ targetId: t.id, keys: ["API_KEY", "EXTRA", "OTHER"] });

    // 가리키는 곳이 바뀌면 점검 기록도 초기화
    const u = await push.updateTarget(agent, t.id, { config: { path: "/private/tmp/drift2/.env" } }, meta);
    expect(u).toMatchObject({ lastDriftAt: null, lastDrift: {}, driftIssues: 0 });
  });

  it("syncGroup: 같은 값이면 일치, 다르면 불일치 · 응답에 값·지문 없음 · 메모/묶음만 바꾸기", async () => {
    const a = await svc.setVar(human, { projectId: p1.id, env: "prod", key: "JWT", value: "same-secret", syncGroup: "jwt" }, meta);
    await svc.setVar(human, { projectId: p2.id, env: "prod", key: "JWT_SECRET", value: "same-secret", syncGroup: "jwt" }, meta);
    let g = await svc.syncGroups(human);
    expect(g).toEqual([
      {
        name: "jwt", consistent: true,
        members: [
          expect.objectContaining({ projectName: "드리프트1", env: "prod", key: "JWT" }),
          expect.objectContaining({ projectName: "드리프트2", env: "prod", key: "JWT_SECRET" }),
        ],
      },
    ]);
    expect(JSON.stringify(g)).not.toContain("same-secret");

    await svc.setVar(human, { projectId: p2.id, env: "prod", key: "JWT_SECRET", value: "different" }, meta); // syncGroup 은 유지
    g = await svc.syncGroups(human);
    expect(g[0].consistent).toBe(false);

    // 값을 건드리지 않고 묶음 해제 → 그룹에서 빠짐, version 그대로
    const before = await prisma.envVar.findUniqueOrThrow({ where: { id: a.id }, select: { version: true, sealed: true } });
    await svc.updateVarMeta(human, a.id, { syncGroup: "" }, meta);
    const after = await prisma.envVar.findUniqueOrThrow({ where: { id: a.id }, select: { version: true, sealed: true, syncGroup: true } });
    expect(after).toEqual({ ...before, syncGroup: null });
    g = await svc.syncGroups(human);
    expect(g[0].members.map((m) => m.key)).toEqual(["JWT_SECRET"]);
    expect(g[0].consistent).toBe(true);
    await expect(svc.updateVarMeta(human, a.id, {}, meta)).rejects.toMatchObject({ status: 400 });
    expect(await prisma.envAccessLog.count({ where: { workspaceId: ws.id, action: "meta" } })).toBe(1);
  });
});
