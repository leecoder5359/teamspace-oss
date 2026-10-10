import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";

/**
 * env 금고 서비스 — 실제 Postgres 로 도는 통합 테스트(가짜 트랜잭션 없이 $transaction·unique·cascade 를 그대로 탄다).
 *
 * 레포의 기본 테스트는 prisma 를 모킹하므로, 이 파일은 **전용 테스트 DB 가 주어질 때만** 돈다:
 *   ENV_VAULT_TEST_DATABASE_URL=postgresql://teamspace:teamspace@localhost:5433/teamspace_envvault_test \
 *     pnpm vitest run lib/envVault/service.db.test.ts
 * (DB 는 `prisma migrate deploy` 로 스키마를 맞춰 둔다. 운영/개발 DB 를 가리키지 말 것 — 데이터를 만들고 지운다.)
 */
const DB = process.env.ENV_VAULT_TEST_DATABASE_URL;

describe.skipIf(!DB)("env 금고 서비스(실DB)", () => {
  // lib/prisma 는 import 시점에 DATABASE_URL 을 읽으므로 먼저 바꾸고 동적 import 한다
  let svc: typeof import("./service");
  let prisma: typeof import("@/lib/prisma").prisma;
  let ws: { id: string };
  let project: { id: string };
  let other: { id: string };
  const meta = { viaFunnel: false };
  let human: { workspaceId: string; userId: string; actor: { type: "user"; id: string; name: string } };
  let agent: { workspaceId: string; userId: string; actor: { type: "agent"; id: string; name: string } };

  beforeAll(async () => {
    process.env.DATABASE_URL = DB;
    process.env.ENV_VAULT_KEY = randomBytes(32).toString("base64");
    delete process.env.AUTH_SLACK_BOT_TOKEN; // 슬랙 발송 없이 승인 행만 만든다
    ({ prisma } = await import("@/lib/prisma"));
    svc = await import("./service");
    ws = await prisma.workspace.create({ data: { name: `envvault-test-${Date.now()}` } });
    const u = await prisma.user.create({ data: { email: `h-${Date.now()}@envvault.test`, name: "사람" } });
    const a = await prisma.user.create({ data: { email: `a-${Date.now()}@envvault.test`, name: "봇" } });
    project = await prisma.project.create({ data: { workspaceId: ws.id, name: "금고테스트" } });
    const ws2 = await prisma.workspace.create({ data: { name: `envvault-other-${Date.now()}` } });
    other = await prisma.project.create({ data: { workspaceId: ws2.id, name: "남의프로젝트" } });
    human = { workspaceId: ws.id, userId: u.id, actor: { type: "user", id: u.id, name: "사람" } };
    agent = { workspaceId: ws.id, userId: a.id, actor: { type: "agent", id: a.id, name: "봇" } };
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.workspace.deleteMany({ where: { name: { startsWith: "envvault-" } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: "@envvault.test" } } });
    await prisma.$disconnect();
  });

  it("set → list 는 값 없이 메타만, DB 에는 암호문만", async () => {
    await svc.setVar(human, { projectId: project.id, env: "dev", key: "API_KEY", value: "plain-secret-1", syncGroup: "api" }, meta);
    const { vars, envs } = await svc.listVars(human, { projectId: project.id });
    expect(await prisma.envAccessLog.count({ where: { workspaceId: ws.id, action: "list" } })).toBe(0);
    expect(envs).toEqual(["dev"]);
    expect(vars).toHaveLength(1);
    expect(vars[0]).toMatchObject({ key: "API_KEY", version: 1, valueLength: 14, syncGroup: "api", updatedByName: "사람" });
    expect(JSON.stringify(vars)).not.toContain("plain-secret-1");
    const row = await prisma.envVar.findFirstOrThrow({ where: { projectId: project.id, key: "API_KEY" } });
    expect(row.sealed).not.toContain("plain-secret-1");
  });

  it("덮어쓰면 version+1 과 직전 암호문 이력", async () => {
    const r = await svc.setVar(human, { projectId: project.id, env: "dev", key: "API_KEY", value: "plain-secret-2" }, meta);
    expect(r).toMatchObject({ version: 2, created: false });
    expect(await prisma.envVarVersion.count({ where: { varId: r.id } })).toBe(1);
    const [v] = await svc.reveal(human, [r.id], meta);
    expect(v.value).toBe("plain-secret-2");
  });

  it("남의 워크스페이스 프로젝트는 400, 잘못된 키 이름은 400", async () => {
    await expect(svc.setVar(human, { projectId: other.id, env: "dev", key: "K", value: "v" }, meta)).rejects.toMatchObject({ status: 400 });
    await expect(svc.setVar(human, { projectId: project.id, env: "dev", key: "bad-key", value: "v" }, meta)).rejects.toMatchObject({ status: 400 });
    await expect(svc.setVar(human, { projectId: project.id, env: "a:b", key: "K", value: "v" }, meta)).rejects.toMatchObject({ status: 400 });
  });

  it("빈 값은 설정·import 모두 거부", async () => {
    await expect(svc.setVar(human, { projectId: project.id, env: "dev", key: "EMPTY", value: "" }, meta)).rejects.toMatchObject({ status: 400, message: "값을 입력해 주세요." });
    await expect(
      svc.requestImport(agent, { projectId: project.id, env: "dev", vars: [{ key: "A_EMPTY", value: "" }, { key: "OK", value: "v" }] }, meta),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining("A_EMPTY") });
    expect(await prisma.envVar.count({ where: { projectId: project.id, key: { in: ["EMPTY", "A_EMPTY", "OK"] } } })).toBe(0);
    expect(await prisma.envOp.count({ where: { workspaceId: ws.id } })).toBe(0);
  });

  it("64KB 초과 값은 거부하고 에러에 값이 없다", async () => {
    const big = "x".repeat(64 * 1024 + 1);
    const err = await svc.setVar(human, { projectId: project.id, env: "dev", key: "BIG", value: big }, meta).catch((e: Error) => e);
    expect((err as unknown as { status: number }).status).toBe(400);
    expect((err as Error).message.length).toBeLessThan(200);
  });

  it("pull 은 키·값 목록 + 감사 로그(키 이름만)", async () => {
    const vars = await svc.pull(agent, project.id, "dev", meta);
    expect(vars).toEqual([{ key: "API_KEY", value: "plain-secret-2" }]);
    const log = await prisma.envAccessLog.findFirstOrThrow({ where: { workspaceId: ws.id, action: "pull" } });
    expect(log).toMatchObject({ actorType: "agent", keys: ["API_KEY"], env: "dev" });
    const all = await prisma.envAccessLog.findMany({ where: { workspaceId: ws.id } });
    expect(JSON.stringify(all)).not.toContain("plain-secret");
  });

  it("purpose=drift 는 같은 값 반출을 drift_read 감사 1행으로만 남긴다(pull 행 없음)", async () => {
    const before = await prisma.envAccessLog.count({ where: { workspaceId: ws.id, action: "pull" } });
    const vars = await svc.pull(agent, project.id, "dev", meta, "drift");
    expect(vars).toEqual([{ key: "API_KEY", value: "plain-secret-2" }]);
    expect(await prisma.envAccessLog.count({ where: { workspaceId: ws.id, action: "pull" } })).toBe(before);
    const rows = await prisma.envAccessLog.findMany({ where: { workspaceId: ws.id, action: "drift_read" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: "agent", keys: ["API_KEY"], env: "dev" });
  });

  it("checkPullPurpose: 기본 pull · drift 허용 · 그 밖 400", () => {
    expect(svc.checkPullPurpose(undefined)).toBe("pull");
    expect(svc.checkPullPurpose("drift")).toBe("drift");
    expect(() => svc.checkPullPurpose("reveal")).toThrow(/purpose/);
  });

  it("import: 요청만으로는 쓰지 않고, 사람 승인 뒤 apply 해야 반영(merge 는 있는 키 유지)", async () => {
    const req = await svc.requestImport(agent, {
      projectId: project.id, env: "dev", mode: "merge",
      vars: [{ key: "API_KEY", value: "from-file" }, { key: "NEW_ONE", value: "n1" }],
    }, meta);
    expect(req.diff).toEqual({ added: ["NEW_ONE"], changed: [], skipped: ["API_KEY"] });
    expect(req.sent).toBe(false);
    const ap = await prisma.approval.findUniqueOrThrow({ where: { id: req.approvalId } });
    expect(ap.highRisk).toBe(true);
    expect(ap.body).toContain("NEW_ONE");
    expect(ap.body).not.toContain("from-file");
    const op = await prisma.envOp.findUniqueOrThrow({ where: { id: req.opId } });
    expect(op.sealedPayload).not.toContain("from-file");

    await expect(svc.applyImport(agent, req.opId, meta)).rejects.toMatchObject({ status: 409 });
    expect(await prisma.envVar.count({ where: { projectId: project.id, key: "NEW_ONE" } })).toBe(0);

    await prisma.approval.update({ where: { id: req.approvalId }, data: { status: "approved" } });
    const r = await svc.applyImport(agent, req.opId, meta);
    expect(r.applied).toEqual({ added: ["NEW_ONE"], changed: [], skipped: ["API_KEY"] });
    const pulled = await svc.pull(agent, project.id, "dev", meta);
    expect(pulled).toEqual([{ key: "API_KEY", value: "plain-secret-2" }, { key: "NEW_ONE", value: "n1" }]);
    const after = await prisma.envOp.findUniqueOrThrow({ where: { id: req.opId } });
    expect(after).toMatchObject({ status: "applied", sealedPayload: null });

    // 두 번 적용 불가
    await expect(svc.applyImport(agent, req.opId, meta)).rejects.toMatchObject({ status: 409 });
  });

  it("import overwrite 는 있는 키도 덮어쓴다", async () => {
    const req = await svc.requestImport(agent, { projectId: project.id, env: "dev", mode: "overwrite", vars: [{ key: "API_KEY", value: "ow" }] }, meta);
    expect(req.diff.changed).toEqual(["API_KEY"]);
    await prisma.approval.update({ where: { id: req.approvalId }, data: { status: "approved" } });
    await svc.applyImport(agent, req.opId, meta);
    expect((await svc.pull(agent, project.id, "dev", meta)).find((v) => v.key === "API_KEY")?.value).toBe("ow");
  });

  it("거부된 승인·만료된 작업은 적용하지 않는다", async () => {
    const rej = await svc.requestImport(agent, { projectId: project.id, env: "dev", vars: [{ key: "REJ", value: "r" }] }, meta);
    await prisma.approval.update({ where: { id: rej.approvalId }, data: { status: "rejected" } });
    await expect(svc.applyImport(agent, rej.opId, meta)).rejects.toMatchObject({ status: 409 });
    expect((await prisma.envOp.findUniqueOrThrow({ where: { id: rej.opId } })).status).toBe("rejected");

    const exp = await svc.requestImport(agent, { projectId: project.id, env: "dev", vars: [{ key: "EXP", value: "e" }] }, meta);
    await prisma.approval.update({ where: { id: exp.approvalId }, data: { status: "approved" } });
    await prisma.envOp.update({ where: { id: exp.opId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(svc.applyImport(agent, exp.opId, meta)).rejects.toMatchObject({ status: 410 });
    expect(await prisma.envVar.count({ where: { projectId: project.id, key: { in: ["REJ", "EXP"] } } })).toBe(0);
  });

  it("delete 는 행과 이력을 함께 지운다", async () => {
    const row = await prisma.envVar.findFirstOrThrow({ where: { projectId: project.id, key: "API_KEY" } });
    await svc.deleteVar(human, row.id, meta);
    expect(await prisma.envVar.count({ where: { id: row.id } })).toBe(0);
    expect(await prisma.envVarVersion.count({ where: { varId: row.id } })).toBe(0);
    await expect(svc.deleteVar(human, row.id, meta)).rejects.toMatchObject({ status: 404 });
  });
});
