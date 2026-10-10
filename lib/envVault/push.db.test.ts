import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";

/**
 * env 금고 P2(대상·push) — 실제 Postgres 통합 테스트. service.db.test.ts 와 같은 전용 DB 가 주어질 때만 돈다:
 *   ENV_VAULT_TEST_DATABASE_URL=postgresql://teamspace:teamspace@localhost:5433/<전용 DB> pnpm vitest run lib/envVault/push.db.test.ts
 * (운영/개발 DB 를 가리키지 말 것 — 데이터를 만들고 지운다.)
 */
const DB = process.env.ENV_VAULT_TEST_DATABASE_URL;

describe.skipIf(!DB)("env 금고 push(실DB)", () => {
  let svc: typeof import("./service");
  let push: typeof import("./push");
  let prisma: typeof import("@/lib/prisma").prisma;
  let ws: { id: string };
  let project: { id: string };
  const meta = { viaFunnel: false };
  const SECRET = "push-secret-value-1";
  let human: { workspaceId: string; userId: string; actor: { type: "user"; id: string; name: string } };
  let agent: { workspaceId: string; userId: string; actor: { type: "agent"; id: string; name: string } };
  let otherAgent: { workspaceId: string; userId: string; actor: { type: "agent"; id: string; name: string } };
  let targetId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = DB;
    process.env.ENV_VAULT_KEY = randomBytes(32).toString("base64");
    delete process.env.AUTH_SLACK_BOT_TOKEN;
    ({ prisma } = await import("@/lib/prisma"));
    svc = await import("./service");
    push = await import("./push");
    const stamp = Date.now();
    ws = await prisma.workspace.create({ data: { name: `envpush-test-${stamp}` } });
    const u = await prisma.user.create({ data: { email: `h-${stamp}@envpush.test`, name: "사람" } });
    const a = await prisma.user.create({ data: { email: `a-${stamp}@envpush.test`, name: "봇" } });
    const b = await prisma.user.create({ data: { email: `b-${stamp}@envpush.test`, name: "남의봇" } });
    project = await prisma.project.create({ data: { workspaceId: ws.id, name: "push테스트" } });
    human = { workspaceId: ws.id, userId: u.id, actor: { type: "user", id: u.id, name: "사람" } };
    agent = { workspaceId: ws.id, userId: a.id, actor: { type: "agent", id: a.id, name: "봇" } };
    otherAgent = { workspaceId: ws.id, userId: b.id, actor: { type: "agent", id: b.id, name: "남의봇" } };
    await svc.setVar(human, { projectId: project.id, env: "dev", key: "API_KEY", value: SECRET }, meta);
    await svc.setVar(human, { projectId: project.id, env: "dev", key: "OTHER", value: "other-value" }, meta);
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.workspace.deleteMany({ where: { name: { startsWith: "envpush-" } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: "@envpush.test" } } });
    await prisma.$disconnect();
  });

  it("대상 추가: 검증·중복 409·비밀 모양 400", async () => {
    const t = await push.createTarget(agent, { projectId: project.id, env: "dev", kind: "dotenv", config: { path: "/private/tmp/x/.env" } }, meta);
    targetId = t.id;
    expect(t).toMatchObject({ kind: "dotenv", summary: "/private/tmp/x/.env", lastPushedAt: null, lastPushedKeys: [] });
    await expect(
      push.createTarget(agent, { projectId: project.id, env: "dev", kind: "dotenv", config: { path: "/private/tmp/x/.env" } }, meta),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      push.createTarget(agent, { projectId: project.id, env: "dev", kind: "gha", config: { repo: "o/r" }, account: { login: "ghp_abcdefghijklmnopqrstuvwxyz0123" } }, meta),
    ).rejects.toMatchObject({ status: 400 });
    await expect(push.createTarget(agent, { projectId: project.id, env: "dev", kind: "ftp", config: {} }, meta)).rejects.toMatchObject({ status: 400 });
    const { vars, targets } = await svc.listVars(human, { projectId: project.id, env: "dev" });
    expect(targets.map((x) => x.id)).toEqual([targetId]);
    expect(vars.map((v) => v.sync[targetId])).toEqual(["never", "never"]);
  });

  it("push: 사람 승인 전에는 claim 불가(409), 승인 뒤 요청한 토큰만 1회", async () => {
    const req = await push.requestPush(agent, targetId, { keys: ["API_KEY"] }, meta);
    expect(req.keys).toEqual(["API_KEY"]);
    const ap = await prisma.approval.findUniqueOrThrow({ where: { id: req.approvalId } });
    expect(ap).toMatchObject({ highRisk: true, kind: "deploy", status: "pending" });
    expect(ap.body).toContain("API_KEY");
    expect(ap.body).not.toContain(SECRET);
    const op = await prisma.envOp.findUniqueOrThrow({ where: { id: req.opId } });
    expect(op).toMatchObject({ kind: "push", mode: "push", targetId, keys: ["API_KEY"] });
    expect(op.sealedPayload).not.toContain(SECRET);

    // 승인 전
    await expect(push.claimPush(agent, req.opId, meta)).rejects.toMatchObject({ status: 409 });
    await expect(push.reportPush(agent, req.opId, { pushed: ["API_KEY"] }, meta)).rejects.toMatchObject({ status: 409 });

    await prisma.approval.update({ where: { id: req.approvalId }, data: { status: "approved" } });
    // 다른 토큰은 가로챌 수 없다
    await expect(push.claimPush(otherAgent, req.opId, meta)).rejects.toMatchObject({ status: 403 });

    const c = await push.claimPush(agent, req.opId, meta);
    expect(c).toEqual({ targetId, vars: [{ key: "API_KEY", value: SECRET }] });
    const claimed = await prisma.envOp.findUniqueOrThrow({ where: { id: req.opId } });
    expect(claimed.status).toBe("claimed");
    expect(claimed.sealedPayload).not.toContain(SECRET);
    // 두 번째 claim 은 409
    await expect(push.claimPush(agent, req.opId, meta)).rejects.toMatchObject({ status: 409 });

    // 결과: 이 작업에 없던 키는 400, 정상 기록 후 다시 기록은 409
    await expect(push.reportPush(agent, req.opId, { pushed: ["OTHER"] }, meta)).rejects.toMatchObject({ status: 400 });
    const r = await push.reportPush(agent, req.opId, { pushed: ["API_KEY"], failed: [] }, meta);
    expect(r).toEqual({ status: "done", pushed: ["API_KEY"], failed: [] });
    await expect(push.reportPush(agent, req.opId, { pushed: ["API_KEY"] }, meta)).rejects.toMatchObject({ status: 409 });

    const t = await prisma.envTarget.findUniqueOrThrow({ where: { id: targetId } });
    expect(t.lastPushedAt).not.toBeNull();
    expect(Object.keys(t.lastPushed as object)).toEqual(["API_KEY"]);
    expect(JSON.stringify(t.lastPushed)).not.toContain(SECRET);

    const list = await svc.listVars(human, { projectId: project.id, env: "dev" });
    expect(Object.fromEntries(list.vars.map((v) => [v.key, v.sync[targetId]]))).toEqual({ API_KEY: "match", OTHER: "never" });
    expect(JSON.stringify(list)).not.toContain(SECRET);
    expect(list.targets[0].lastPushedKeys).toEqual(["API_KEY"]);
  });

  it("값을 바꾸면 differs, 같은 값으로 되돌리면 다시 match", async () => {
    await svc.setVar(human, { projectId: project.id, env: "dev", key: "API_KEY", value: "changed" }, meta);
    let list = await svc.listVars(human, { projectId: project.id, env: "dev" });
    expect(list.vars.find((v) => v.key === "API_KEY")?.sync[targetId]).toBe("differs");
    await svc.setVar(human, { projectId: project.id, env: "dev", key: "API_KEY", value: SECRET }, meta);
    list = await svc.listVars(human, { projectId: project.id, env: "dev" });
    expect(list.vars.find((v) => v.key === "API_KEY")?.sync[targetId]).toBe("match");
  });

  it("요청 뒤 값이 바뀌면 claim 거부(409, 값 안 나감)·거부된 승인·만료", async () => {
    const stale = await push.requestPush(agent, targetId, {}, meta);
    expect(stale.keys).toEqual(["API_KEY", "OTHER"]);
    await prisma.approval.update({ where: { id: stale.approvalId }, data: { status: "approved" } });
    await svc.setVar(human, { projectId: project.id, env: "dev", key: "OTHER", value: "other-2" }, meta);
    await expect(push.claimPush(agent, stale.opId, meta)).rejects.toMatchObject({ status: 409 });
    expect((await prisma.envOp.findUniqueOrThrow({ where: { id: stale.opId } })).status).toBe("expired");

    const rej = await push.requestPush(agent, targetId, { keys: ["OTHER"] }, meta);
    await prisma.approval.update({ where: { id: rej.approvalId }, data: { status: "rejected" } });
    await expect(push.claimPush(agent, rej.opId, meta)).rejects.toMatchObject({ status: 409 });
    expect((await prisma.envOp.findUniqueOrThrow({ where: { id: rej.opId } })).status).toBe("rejected");

    const exp = await push.requestPush(agent, targetId, { keys: ["OTHER"] }, meta);
    await prisma.approval.update({ where: { id: exp.approvalId }, data: { status: "approved" } });
    await prisma.envOp.update({ where: { id: exp.opId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(push.claimPush(agent, exp.opId, meta)).rejects.toMatchObject({ status: 410 });

    await expect(push.requestPush(agent, targetId, { keys: ["NOPE"] }, meta)).rejects.toMatchObject({ status: 400 });
  });

  it("부분 실패는 partial, 반영된 키만 지문 갱신", async () => {
    const req = await push.requestPush(agent, targetId, {}, meta);
    await prisma.approval.update({ where: { id: req.approvalId }, data: { status: "approved" } });
    await push.claimPush(agent, req.opId, meta);
    const r = await push.reportPush(agent, req.opId, { pushed: ["OTHER"], failed: [{ key: "API_KEY", error: "boom" }] }, meta);
    expect(r.status).toBe("partial");
    const list = await svc.listVars(human, { projectId: project.id, env: "dev" });
    expect(Object.fromEntries(list.vars.map((v) => [v.key, v.sync[targetId]]))).toEqual({ API_KEY: "match", OTHER: "match" });
  });

  it("감사 로그에는 값이 없고, 대상을 옮기면 반영 기록을 지운다·삭제", async () => {
    const logs = await prisma.envAccessLog.findMany({ where: { workspaceId: ws.id } });
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(["target_add", "push_request", "push", "push_result"]));
    expect(JSON.stringify(logs)).not.toContain(SECRET);
    const moved = await push.updateTarget(human, targetId, { config: { path: "/private/tmp/y/.env" } }, meta);
    expect(moved).toMatchObject({ summary: "/private/tmp/y/.env", lastPushedAt: null, lastPushedKeys: [] });
    await push.deleteTarget(human, targetId, meta);
    expect(await prisma.envTarget.count({ where: { id: targetId } })).toBe(0);
    expect(await prisma.envOp.count({ where: { targetId } })).toBe(0);
  });
});
