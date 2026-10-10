import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { randomBytes } from "node:crypto";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/envVault/push", () => ({
  listTargets: vi.fn(), createTarget: vi.fn(), updateTarget: vi.fn(), deleteTarget: vi.fn(),
  requestPush: vi.fn(), claimPush: vi.fn(), reportPush: vi.fn(), recordDrift: vi.fn(),
}));

import { requireCtx } from "@/lib/workspace";
import * as push from "@/lib/envVault/push";
import { GET as listRoute, POST as addRoute } from "./route";
import { PATCH as patchRoute, DELETE as delRoute } from "./[id]/route";
import { POST as pushRoute } from "./[id]/push/route";
import { POST as driftRoute } from "./[id]/drift/route";
import { EnvVaultError } from "@/lib/envVault/service";
import { POST as claimRoute } from "../push/[opId]/claim/route";
import { POST as resultRoute } from "../push/[opId]/result/route";

const m = (f: unknown) => f as Mock;
const adminAgent = { workspaceId: "w1", userId: "a1", role: "admin", actor: { type: "agent", id: "a1", name: "bot" } };
const editorAgent = { ...adminAgent, role: "editor" };
const editorUser = { workspaceId: "w1", userId: "u1", role: "editor", actor: { type: "user", id: "u1", name: "U" } };
const json = (url: string, method: string, body: unknown) =>
  new Request(`http://t${url}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const p = <T>(v: T) => ({ params: Promise.resolve(v) });

describe("/api/env/targets·push 권한", () => {
  const prev = process.env.ENV_VAULT_KEY;
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.ENV_VAULT_KEY = randomBytes(32).toString("base64");
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ENV_VAULT_KEY;
    else process.env.ENV_VAULT_KEY = prev;
  });

  it("금고가 꺼져 있으면 503", async () => {
    delete process.env.ENV_VAULT_KEY;
    m(requireCtx).mockResolvedValue(adminAgent);
    expect((await listRoute(new Request("http://t/api/env/targets"))).status).toBe(503);
    expect(push.listTargets).not.toHaveBeenCalled();
  });

  it("목록은 viewer 이상(requireCtx 기본), id·projectId·env 필터 전달", async () => {
    m(requireCtx).mockResolvedValue({ ...editorUser, role: "viewer" });
    m(push.listTargets).mockResolvedValue([]);
    const res = await listRoute(new Request("http://t/api/env/targets?projectId=p1&env=dev&id=t1"));
    expect(res.status).toBe(200);
    expect(requireCtx).toHaveBeenCalledWith();
    expect(m(push.listTargets).mock.calls[0][1]).toEqual({ projectId: "p1", env: "dev", id: "t1" });
  });

  it("추가·수정·삭제·push 요청: 에이전트는 editor 이상, 사람 세션은 admin(관문은 사람 승인 클릭)", async () => {
    m(requireCtx).mockResolvedValue(editorAgent);
    m(push.createTarget).mockResolvedValue({ id: "t1" });
    m(push.updateTarget).mockResolvedValue({ id: "t1" });
    m(push.requestPush).mockResolvedValue({ opId: "o1", approvalId: "ap1", sent: false, keys: ["K"], expiresAt: new Date() });
    const add = await addRoute(json("/api/env/targets", "POST", { projectId: "p1", env: "dev", kind: "dotenv", config: { path: "/a/.env" } }));
    expect(add.status).toBe(201);
    expect((await patchRoute(json("/api/env/targets/t1", "PATCH", { account: {} }), p({ id: "t1" }))).status).toBe(200);
    expect((await delRoute(new Request("http://t/api/env/targets/t1", { method: "DELETE" }), p({ id: "t1" }))).status).toBe(200);
    const pr = await pushRoute(json("/api/env/targets/t1/push", "POST", { keys: ["K"], channel: "C1" }), p({ id: "t1" }));
    expect(pr.status).toBe(200);
    expect(m(push.requestPush).mock.calls[0].slice(1, 3)).toEqual(["t1", { keys: ["K"], channel: "C1" }]);
    expect(m(requireCtx).mock.calls.every((c) => c[0] === "editor")).toBe(true);

    // editor 사람 세션은 403(서비스 미호출), admin 사람 세션은 허용
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue(editorUser);
    expect((await addRoute(json("/api/env/targets", "POST", { projectId: "p1", env: "dev", kind: "dotenv", config: { path: "/a/.env" } }))).status).toBe(403);
    expect((await patchRoute(json("/api/env/targets/t1", "PATCH", { account: {} }), p({ id: "t1" }))).status).toBe(403);
    expect((await delRoute(new Request("http://t/api/env/targets/t1", { method: "DELETE" }), p({ id: "t1" }))).status).toBe(403);
    expect((await pushRoute(json("/api/env/targets/t1/push", "POST", {}), p({ id: "t1" }))).status).toBe(403);
    expect(push.createTarget).not.toHaveBeenCalled();
    expect(push.updateTarget).not.toHaveBeenCalled();
    expect(push.deleteTarget).not.toHaveBeenCalled();
    expect(push.requestPush).not.toHaveBeenCalled();

    m(requireCtx).mockResolvedValue({ ...editorUser, role: "admin" });
    m(push.createTarget).mockResolvedValue({ id: "t2" });
    expect((await addRoute(json("/api/env/targets", "POST", { projectId: "p1", env: "dev", kind: "dotenv", config: { path: "/a/.env" } }))).status).toBe(201);
  });

  it("claim: editor 에이전트 허용·no-store, editor 사람은 403", async () => {
    m(requireCtx).mockResolvedValue(editorAgent);
    m(push.claimPush).mockResolvedValue({ targetId: "t1", vars: [{ key: "K", value: "v" }] });
    const ok = await claimRoute(new Request("http://t/api/env/push/o1/claim", { method: "POST" }), p({ opId: "o1" }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Cache-Control")).toBe("no-store");
    expect(requireCtx).toHaveBeenCalledWith("editor");

    m(requireCtx).mockResolvedValue(editorUser);
    const denied = await claimRoute(new Request("http://t/api/env/push/o1/claim", { method: "POST" }), p({ opId: "o1" }));
    expect(denied.status).toBe(403);
  });

  it("result 는 키 이름만 서비스로 넘긴다(클라이언트 해시 필드는 무시)", async () => {
    m(requireCtx).mockResolvedValue(editorAgent);
    m(push.reportPush).mockResolvedValue({ status: "done", pushed: ["K"], failed: [] });
    const res = await resultRoute(json("/api/env/push/o1/result", "POST", { pushed: ["K"], failed: [], hashes: { K: "forged" } }), p({ opId: "o1" }));
    expect(res.status).toBe(200);
    expect(m(push.reportPush).mock.calls[0][2]).toEqual({ pushed: ["K"], failed: [] });
  });

  it("drift: 에이전트 editor 이상·사람은 admin, results 만 서비스로(다른 필드는 무시), 검증 에러는 400", async () => {
    m(requireCtx).mockResolvedValue(editorAgent);
    m(push.recordDrift).mockResolvedValue({ target: { id: "t1" }, counts: {} });
    const ok = await driftRoute(json("/api/env/targets/t1/drift", "POST", { results: { K: "match" }, values: { K: "leak" } }), p({ id: "t1" }));
    expect(ok.status).toBe(200);
    expect(requireCtx).toHaveBeenCalledWith("editor");
    expect(m(push.recordDrift).mock.calls[0].slice(1, 3)).toEqual(["t1", { results: { K: "match" } }]);

    m(push.recordDrift).mockRejectedValue(new EnvVaultError(400, "K: 상태는 ..."));
    expect((await driftRoute(json("/api/env/targets/t1/drift", "POST", { results: { K: "bogus" } }), p({ id: "t1" }))).status).toBe(400);

    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue(editorUser);
    expect((await driftRoute(json("/api/env/targets/t1/drift", "POST", { results: {} }), p({ id: "t1" }))).status).toBe(403);
    expect(push.recordDrift).not.toHaveBeenCalled();
    m(requireCtx).mockResolvedValue({ ...editorUser, role: "admin" });
    m(push.recordDrift).mockResolvedValue({ target: { id: "t1" }, counts: {} });
    expect((await driftRoute(json("/api/env/targets/t1/drift", "POST", { results: {} }), p({ id: "t1" }))).status).toBe(200);
  });
});
