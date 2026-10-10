import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { randomBytes } from "node:crypto";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/envVault/service", async (orig) => {
  const real = await orig<typeof import("@/lib/envVault/service")>();
  return {
    ...real,
    listVars: vi.fn(), setVar: vi.fn(), deleteVar: vi.fn(), reveal: vi.fn(), pull: vi.fn(),
    requestImport: vi.fn(), applyImport: vi.fn(), accessLog: vi.fn(), updateVarMeta: vi.fn(), syncGroups: vi.fn(),
  };
});

import { requireCtx } from "@/lib/workspace";
import * as svc from "@/lib/envVault/service";
import { GET as list } from "./route";
import { PUT as setVarRoute } from "./vars/route";
import { DELETE as delVar, PATCH as patchVar } from "./vars/[id]/route";
import { GET as syncGroupsRoute } from "./sync-groups/route";
import { POST as revealRoute } from "./reveal/route";
import { POST as pullRoute } from "./pull/route";
import { POST as importRoute } from "./import/route";
import { GET as logRoute } from "./log/route";

const m = (f: unknown) => f as Mock;
const adminUser = { workspaceId: "w1", userId: "u1", role: "admin", actor: { type: "user", id: "u1", name: "U" } };
const editorUser = { ...adminUser, role: "editor" };
const adminAgent = { workspaceId: "w1", userId: "a1", role: "admin", actor: { type: "agent", id: "a1", name: "bot" } };
const editorAgent = { ...adminAgent, role: "editor" };

const json = (url: string, method: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://t${url}`, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("/api/env 권한·비활성", () => {
  const prev = process.env.ENV_VAULT_KEY;
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.ENV_VAULT_KEY = randomBytes(32).toString("base64");
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ENV_VAULT_KEY;
    else process.env.ENV_VAULT_KEY = prev;
  });

  it("ENV_VAULT_KEY 가 없으면 503 + 안내", async () => {
    delete process.env.ENV_VAULT_KEY;
    m(requireCtx).mockResolvedValue(adminUser);
    const res = await list(new Request("http://t/api/env?projectId=p1"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("ENV_VAULT_KEY");
    expect(svc.listVars).not.toHaveBeenCalled();
  });

  it("목록은 viewer 이상이면 되고 감사 메타를 넘기지 않는다(목록은 감사 로그에 안 남김)", async () => {
    m(requireCtx).mockResolvedValue({ ...adminUser, role: "viewer" });
    m(svc.listVars).mockResolvedValue({ vars: [], envs: [] });
    const res = await list(new Request("http://t/api/env?projectId=p1&env=dev", { headers: { "Tailscale-Funnel-Request": "?1" } }));
    expect(res.status).toBe(200);
    expect(requireCtx).toHaveBeenCalledWith(); // 기본 viewer
    expect(m(svc.listVars).mock.calls[0][1]).toEqual({ projectId: "p1", env: "dev" });
    expect(m(svc.listVars).mock.calls[0]).toHaveLength(2);
  });

  it("값 설정·삭제·열람은 에이전트 토큰이면 admin 이어도 403", async () => {
    m(requireCtx).mockResolvedValue(adminAgent);
    expect((await setVarRoute(json("/api/env/vars", "PUT", { projectId: "p1", env: "dev", key: "K", value: "v" }))).status).toBe(403);
    expect((await delVar(new Request("http://t/api/env/vars/x", { method: "DELETE" }), { params: Promise.resolve({ id: "x" }) })).status).toBe(403);
    expect((await revealRoute(json("/api/env/reveal", "POST", { ids: ["x"] }))).status).toBe(403);
    expect(svc.setVar).not.toHaveBeenCalled();
    expect(svc.deleteVar).not.toHaveBeenCalled();
    expect(svc.reveal).not.toHaveBeenCalled();
  });

  it("값 설정·열람은 admin 로그인 세션 필요(requireCtx admin)", async () => {
    m(requireCtx).mockResolvedValue(adminUser);
    m(svc.reveal).mockResolvedValue([{ id: "x", env: "dev", key: "K", value: "v" }]);
    const res = await revealRoute(json("/api/env/reveal", "POST", { ids: ["x"] }));
    expect(requireCtx).toHaveBeenCalledWith("admin");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("pull: editor 에이전트 허용·no-store, editor 사람은 403", async () => {
    m(requireCtx).mockResolvedValue(editorAgent);
    m(svc.pull).mockResolvedValue([{ key: "K", value: "v" }]);
    const ok = await pullRoute(json("/api/env/pull", "POST", { projectId: "p1", env: "dev" }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Cache-Control")).toBe("no-store");

    m(requireCtx).mockResolvedValue(editorUser);
    const denied = await pullRoute(json("/api/env/pull", "POST", { projectId: "p1", env: "dev" }));
    expect(denied.status).toBe(403);
  });

  it("pull purpose: 기본 pull, drift 는 서비스에 drift 로 전달(감사 drift_read), 그 밖은 400·서비스 미호출", async () => {
    m(requireCtx).mockResolvedValue(editorAgent);
    m(svc.pull).mockResolvedValue([]);
    await pullRoute(json("/api/env/pull", "POST", { projectId: "p1", env: "dev" }));
    expect(m(svc.pull).mock.calls[0][4]).toBe("pull");
    await pullRoute(json("/api/env/pull", "POST", { projectId: "p1", env: "dev", purpose: "drift" }));
    expect(m(svc.pull).mock.calls[1][4]).toBe("drift");
    const bad = await pullRoute(json("/api/env/pull", "POST", { projectId: "p1", env: "dev", purpose: "x" }));
    expect(bad.status).toBe(400);
    expect(svc.pull).toHaveBeenCalledTimes(2);
  });

  it("import 는 editor 이상(에이전트 포함) — 서비스가 승인 대기를 만든다", async () => {
    m(requireCtx).mockResolvedValue(editorAgent);
    m(svc.requestImport).mockResolvedValue({ opId: "o1", approvalId: "ap1", sent: true, diff: { added: ["K"], changed: [], skipped: [] }, expiresAt: new Date() });
    const res = await importRoute(json("/api/env/import", "POST", { projectId: "p1", env: "dev", vars: [{ key: "K", value: "v" }], mode: "merge" }));
    expect(requireCtx).toHaveBeenCalledWith("editor");
    expect(res.status).toBe(200);
    expect((await res.json()).opId).toBe("o1");
  });

  it("서비스 에러는 상태코드 그대로, 알 수 없는 에러는 메시지를 숨긴다", async () => {
    m(requireCtx).mockResolvedValue(adminUser);
    m(svc.setVar).mockRejectedValue(new svc.EnvVaultError(400, "키 이름 형식이 올바르지 않습니다"));
    const bad = await setVarRoute(json("/api/env/vars", "PUT", { projectId: "p1", env: "dev", key: "x", value: "SECRET_VALUE" }));
    expect(bad.status).toBe(400);

    vi.spyOn(console, "error").mockImplementation(() => {});
    m(svc.setVar).mockRejectedValue(new Error("boom SECRET_VALUE"));
    const boom = await setVarRoute(json("/api/env/vars", "PUT", { projectId: "p1", env: "dev", key: "K", value: "SECRET_VALUE" }));
    expect(boom.status).toBe(500);
    expect(JSON.stringify(await boom.json())).not.toContain("SECRET_VALUE");
    const logged = JSON.stringify(m(console.error).mock.calls);
    expect(logged).not.toContain("SECRET_VALUE");
  });

  it("감사 로그는 admin", async () => {
    m(requireCtx).mockResolvedValue(adminAgent);
    m(svc.accessLog).mockResolvedValue([]);
    const res = await logRoute(new Request("http://t/api/env/log?projectId=p1"));
    expect(requireCtx).toHaveBeenCalledWith("admin");
    expect(res.status).toBe(200);
  });

  it("syncGroup·메모 변경(PATCH vars/[id])은 admin 로그인 세션만, 값은 받지 않는다", async () => {
    const p = { params: Promise.resolve({ id: "v1" }) };
    m(requireCtx).mockResolvedValue(adminAgent);
    expect((await patchVar(json("/api/env/vars/v1", "PATCH", { syncGroup: "db" }), p)).status).toBe(403);
    expect(svc.updateVarMeta).not.toHaveBeenCalled();
    m(requireCtx).mockResolvedValue(adminUser);
    m(svc.updateVarMeta).mockResolvedValue({ id: "v1", note: null, syncGroup: "db" });
    const ok = await patchVar(json("/api/env/vars/v1", "PATCH", { syncGroup: "db", value: "ignored" }), p);
    expect(ok.status).toBe(200);
    expect(requireCtx).toHaveBeenLastCalledWith("admin");
    expect(m(svc.updateVarMeta).mock.calls[0].slice(1, 3)).toEqual(["v1", { note: undefined, syncGroup: "db" }]);
  });

  it("sync-groups 는 viewer 이상, 금고가 꺼져 있으면 503", async () => {
    m(requireCtx).mockResolvedValue({ ...editorUser, role: "viewer" });
    m(svc.syncGroups).mockResolvedValue([{ name: "db", consistent: false, members: [] }]);
    const res = await syncGroupsRoute();
    expect(res.status).toBe(200);
    expect(requireCtx).toHaveBeenCalledWith();
    expect(await res.json()).toEqual({ syncGroups: [{ name: "db", consistent: false, members: [] }] });
    delete process.env.ENV_VAULT_KEY;
    expect((await syncGroupsRoute()).status).toBe(503);
  });
});
