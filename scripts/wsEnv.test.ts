import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  buildTargetSpec, checkAccount, envDrift, envTargetLs, envGroups, envImport, envLs, envPull, envPush, planPush, pushDotenv, pushGha, pushSsm, pushVercel, readSsm, resolveProject,
  type ApiFn, type ExecFn, type ExecOpts, type TargetInfo,
} from "./wsEnv";
import { parseDotenv, serializeDotenv } from "../lib/envVault/dotenv";

/**
 * env 금고 CLI — 값이 화면(stdout/stderr)에 절대 나오지 않음을 고정한다.
 * console.* 와 process.stdout/stderr.write 를 모두 가로채 비밀 문자열이 없는지 본다.
 */
const SECRET = "sk_live_SUPER_SECRET_value_123";
const PROJECTS = { projects: [{ id: "p1", name: "반장", short: "BJ" }, { id: "p2", name: "로요", short: null }] };

function captureAll() {
  const chunks: string[] = [];
  const push = (...a: unknown[]) => void chunks.push(a.map(String).join(" "));
  const spies = [
    vi.spyOn(console, "log").mockImplementation(push),
    vi.spyOn(console, "error").mockImplementation(push),
    vi.spyOn(console, "warn").mockImplementation(push),
    vi.spyOn(console, "info").mockImplementation(push),
    vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => (push(c), true)),
    vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => (push(c), true)),
  ];
  return { text: () => chunks.join("\n"), restore: () => spies.forEach((s) => s.mockRestore()) };
}

describe("ws env pull", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsenv-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const api: ApiFn = async (method, path) => {
    if (path === "/api/projects") return PROJECTS;
    if (method === "POST" && path === "/api/env/pull") return { vars: [{ key: "API_KEY", value: SECRET }, { key: "MULTI", value: "a b\n\"c\"" }] };
    throw new Error(`unexpected ${method} ${path}`);
  };

  it("값을 출력하지 않고 0600 파일로만 쓴다", async () => {
    const out = join(dir, ".env.local");
    const cap = captureAll();
    try {
      await envPull({ api, log: (l) => console.log(l) }, { project: "반장", env: "dev", out, force: false });
    } finally {
      cap.restore();
    }
    expect(cap.text()).not.toContain(SECRET);
    expect(cap.text()).toContain("2개 키");
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(parseDotenv(readFileSync(out, "utf8"))).toEqual([{ key: "API_KEY", value: SECRET }, { key: "MULTI", value: "a b\n\"c\"" }]);
  });

  it("기존 파일이 있으면 키 이름 diff 만 보이고 --force 없이는 덮어쓰지 않는다", async () => {
    const out = join(dir, ".env");
    writeFileSync(out, "OLD_ONLY=old-secret-xyz\nAPI_KEY=previous\n", { mode: 0o644 });
    const cap = captureAll();
    try {
      await envPull({ api, log: (l) => console.log(l) }, { project: "p1", env: "dev", out, force: false });
    } finally {
      cap.restore();
    }
    const t = cap.text();
    expect(t).toContain("OLD_ONLY");
    expect(t).toContain("MULTI");
    expect(t).toContain("--force");
    expect(t).not.toContain(SECRET);
    expect(t).not.toContain("old-secret-xyz");
    expect(readFileSync(out, "utf8")).toContain("OLD_ONLY"); // 그대로

    const cap2 = captureAll();
    try {
      await envPull({ api, log: (l) => console.log(l) }, { project: "p1", env: "dev", out, force: true });
    } finally {
      cap2.restore();
    }
    expect(cap2.text()).not.toContain(SECRET);
    expect(readFileSync(out, "utf8")).not.toContain("OLD_ONLY");
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });
});

describe("ws env import", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsenv-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("드라이런: 키 이름 diff 만, 서버에 쓰기 요청 없음, 값 출력 없음", async () => {
    const file = join(dir, ".env");
    writeFileSync(file, `API_KEY=${SECRET}\nexport NEW_ONE="x y"\nlower=skip\n`);
    const calls: string[] = [];
    const api: ApiFn = async (method, path) => {
      calls.push(`${method} ${path.split("?")[0]}`);
      if (path === "/api/projects") return PROJECTS;
      if (path.startsWith("/api/env?")) return { vars: [{ key: "API_KEY" }] };
      throw new Error(`unexpected ${method} ${path}`);
    };
    const cap = captureAll();
    try {
      await envImport({ api, log: (l) => console.log(l) }, { project: "반장", env: "dev", from: file, overwrite: false, apply: false });
    } finally {
      cap.restore();
    }
    const t = cap.text();
    expect(t).not.toContain(SECRET);
    expect(t).toMatch(/추가 1: NEW_ONE/);
    expect(t).toMatch(/건너뜀\(이미 있음\) 1: API_KEY/);
    expect(t).toContain("lower"); // 형식 불량 키는 이름만 안내
    expect(calls).toEqual(["GET /api/projects", "GET /api/env"]);
  });

  it("--apply: 승인 대기 → approved 되면 apply, 값은 요청 본문에만", async () => {
    const file = join(dir, ".env");
    writeFileSync(file, `API_KEY=${SECRET}\n`);
    const bodies: unknown[] = [];
    let polls = 0;
    const api: ApiFn = async (method, path, body) => {
      if (path === "/api/projects") return PROJECTS;
      if (path.startsWith("/api/env?")) return { vars: [] };
      if (method === "POST" && path === "/api/env/import") {
        bodies.push(body);
        return { opId: "o1", approvalId: "ap1", sent: true };
      }
      if (path === "/api/approvals/ap1") return { approval: { status: ++polls < 3 ? "pending" : "approved" } };
      if (method === "POST" && path === "/api/env/import/o1/apply") return { applied: { added: ["API_KEY"], changed: [], skipped: [] } };
      throw new Error(`unexpected ${method} ${path}`);
    };
    const sleep = vi.fn(async () => {});
    const cap = captureAll();
    try {
      await envImport({ api, log: (l) => console.log(l), sleep }, { project: "p1", env: "dev", from: file, overwrite: false, apply: true, channel: "C1" });
    } finally {
      cap.restore();
    }
    expect(cap.text()).not.toContain(SECRET);
    expect(cap.text()).toContain("반영 완료: 추가 1");
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(bodies[0]).toMatchObject({ projectId: "p1", env: "dev", mode: "merge", channel: "C1", vars: [{ key: "API_KEY", value: SECRET }] });
  });

  it("빈 값 키가 있으면 드라이런부터 키 이름을 알리고 중단(서버 호출 없음)", async () => {
    const file = join(dir, ".env");
    writeFileSync(file, `API_KEY=${SECRET}\nEMPTY_ONE=\n`);
    const api = vi.fn<ApiFn>(async () => PROJECTS);
    const err = await envImport({ api, log: () => {} }, { project: "p1", env: "dev", from: file, overwrite: false, apply: true }).catch((e: Error) => e);
    expect((err as Error).message).toContain("EMPTY_ONE");
    expect((err as Error).message).not.toContain(SECRET);
    expect(api.mock.calls.map((c) => c[1])).toEqual(["/api/projects"]);
  });

  it("거부되면 적용하지 않고 실패", async () => {
    const file = join(dir, ".env");
    writeFileSync(file, `API_KEY=${SECRET}\n`);
    const applied = vi.fn();
    const api: ApiFn = async (method, path) => {
      if (path === "/api/projects") return PROJECTS;
      if (path.startsWith("/api/env?")) return { vars: [] };
      if (path === "/api/env/import") return { opId: "o1", approvalId: "ap1", sent: true };
      if (path === "/api/approvals/ap1") return { approval: { status: "rejected", responseText: "안 돼요" } };
      applied();
      return {};
    };
    await expect(
      envImport({ api, log: () => {}, sleep: async () => {} }, { project: "p1", env: "dev", from: file, overwrite: true, apply: true }),
    ).rejects.toThrow(/rejected/);
    expect(applied).not.toHaveBeenCalled();
  });
});

describe("ssm 가져오기", () => {
  it("셸 없이 aws 인자 배열로 호출하고 키=경로 마지막 조각", async () => {
    const exec = vi.fn<(file: string, args: string[]) => Promise<string>>(async () =>
      JSON.stringify({ Parameters: [{ Name: "/app/dev/DB_URL", Value: SECRET }, { Name: "/app/dev/nested/bad-name", Value: "x" }] }),
    );
    const r = await readSsm({ kind: "ssm", prefix: "/app/dev", profile: "work", region: "ap-northeast-2" }, exec);
    expect(exec).toHaveBeenCalledWith("aws", [
      "ssm", "get-parameters-by-path", "--path", "/app/dev", "--recursive", "--with-decryption", "--output", "json",
      "--profile", "work", "--region", "ap-northeast-2",
    ]);
    expect(r.vars).toEqual([{ key: "DB_URL", value: SECRET }]);
    expect(r.skipped).toEqual(["/app/dev/nested/bad-name"]);
  });
});

describe("프로젝트 참조", () => {
  const api: ApiFn = async () => PROJECTS;
  it("id·이름·short(대소문자 무시)", async () => {
    expect((await resolveProject(api, "p2")).name).toBe("로요");
    expect((await resolveProject(api, "반장")).id).toBe("p1");
    expect((await resolveProject(api, "bj")).id).toBe("p1");
    await expect(resolveProject(api, "없음")).rejects.toThrow(/찾을 수 없습니다/);
  });
});

describe("dotenv 왕복", () => {
  it("따옴표·이스케이프·주석", () => {
    const vars = [{ key: "A", value: "plain" }, { key: "B", value: "has space # and \"q\"\nline2" }, { key: "C", value: "" }];
    expect(parseDotenv(serializeDotenv(vars, "헤더"))).toEqual(vars);
    expect(parseDotenv("X=1 # 주석\nY='a#b'\n# c\n")).toEqual([{ key: "X", value: "1" }, { key: "Y", value: "a#b" }]);
  });
});

// ══ P2: 대상·push ═══════════════════════════════════════════════════════
type Call = { file: string; args: string[]; opts?: ExecOpts };
function recordingExec(respond: (c: Call) => string | Promise<string> = () => "") {
  const calls: Call[] = [];
  const exec: ExecFn = async (file, args, opts) => {
    const c = { file, args, opts };
    calls.push(c);
    return respond(c);
  };
  return { exec, calls };
}
const target = (kind: TargetInfo["kind"], config: TargetInfo["config"], account: TargetInfo["account"] = {}, env = "dev"): TargetInfo => ({
  id: "t1", projectId: "p1", env, kind, config, account, summary: "s", accountSummary: "a", lastPushedAt: null,
});

describe("ws env target add 인자", () => {
  it("종류별 필수 플래그·상대 경로는 절대 경로로", () => {
    expect(buildTargetSpec({ kind: "dotenv", path: "rel/.env" }).config.path).toBe(join(process.cwd(), "rel/.env"));
    expect(buildTargetSpec({ kind: "dotenv", path: "~/x/.env" }).config.path).toBe("~/x/.env");
    expect(buildTargetSpec({ kind: "ssm", prefix: "/app/dev", profile: "work", account: "123456789012" })).toEqual({
      kind: "ssm", config: { prefix: "/app/dev", profile: "work" }, account: { accountId: "123456789012" },
    });
    expect(buildTargetSpec({ kind: "vercel", vercelProject: "web", target: "preview", scope: "team", account: "me" })).toEqual({
      kind: "vercel", config: { project: "web", target: "preview", scope: "team" }, account: { user: "me" },
    });
    expect(buildTargetSpec({ kind: "gha", repo: "o/r", ghEnv: "prod", account: "me" })).toEqual({
      kind: "gha", config: { repo: "o/r", environment: "prod" }, account: { login: "me" },
    });
    expect(() => buildTargetSpec({ kind: "gha", repo: "o/r" })).toThrow(/--account/);
    expect(() => buildTargetSpec({ kind: "vercel", account: "me" })).toThrow(/--vercel-project/);
    expect(() => buildTargetSpec({ kind: "s3" })).toThrow(/--kind/);
  });
});

describe("계정 확인", () => {
  it("aws 계정이 다르면 거부", async () => {
    const { exec, calls } = recordingExec(() => JSON.stringify({ Account: "999999999999", Arn: "arn:x" }));
    await expect(checkAccount(target("ssm", { prefix: "/a", profile: "work" }, { accountId: "123456789012" }), exec)).rejects.toThrow(/계정이 다릅니다.*999999999999/);
    expect(calls[0]).toMatchObject({ file: "aws", args: ["sts", "get-caller-identity", "--output", "json", "--profile", "work"] });
  });

  it("vercel 은 -Q·--scope 를 붙여 whoami, 사용자가 다르면 거부", async () => {
    const { exec, calls } = recordingExec(() => JSON.stringify({ username: "company-bot" }));
    const t = target("vercel", { project: "web", target: "production", scope: "team", globalDir: "/g" }, { user: "me" });
    await expect(checkAccount(t, exec)).rejects.toThrow(/Vercel company-bot/);
    expect(calls[0].args).toEqual(["-Q", "/g", "whoami", "--format", "json", "--scope", "team"]);
    const ok = recordingExec(() => JSON.stringify({ username: "Me" }));
    expect(await checkAccount(t, ok.exec)).toContain("Vercel Me");
  });

  it("gh 는 GITHUB_TOKEN/GH_TOKEN 을 빼고 본인 로그인으로 확인", async () => {
    const prevA = process.env.GITHUB_TOKEN;
    const prevB = process.env.GH_TOKEN;
    process.env.GITHUB_TOKEN = "company-token";
    process.env.GH_TOKEN = "company-token-2";
    try {
      const { exec, calls } = recordingExec(() => "someone-else\n");
      await expect(checkAccount(target("gha", { repo: "o/r" }, { login: "me" }), exec)).rejects.toThrow(/GitHub someone-else/);
      expect(calls[0].args).toEqual(["api", "user", "--jq", ".login"]);
      expect(calls[0].opts?.env?.GITHUB_TOKEN).toBeUndefined();
      expect(calls[0].opts?.env?.GH_TOKEN).toBeUndefined();
      expect(calls[0].opts?.env?.PATH).toBe(process.env.PATH);
    } finally {
      if (prevA === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prevA;
      if (prevB === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = prevB;
    }
  });

  it("계정이 다르면 push 는 승인 요청도 만들지 않는다", async () => {
    const calls: string[] = [];
    const api: ApiFn = async (method, path) => {
      calls.push(`${method} ${path.split("?")[0]}`);
      if (path.startsWith("/api/env/targets?")) return { targets: [target("gha", { repo: "o/r" }, { login: "me" })] };
      throw new Error(`unexpected ${method} ${path}`);
    };
    const { exec } = recordingExec(() => "intruder\n");
    await expect(envPush({ api, log: () => {}, exec }, { targetId: "t1", apply: true, wait: true })).rejects.toThrow(/계정이 다릅니다/);
    expect(calls).toEqual(["GET /api/env/targets"]);
  });
});

describe("push 어댑터 — 값은 stdin·0600 임시 파일로만, 인자에는 절대 없음", () => {
  const vars = [{ key: "API_KEY", value: SECRET }, { key: "OTHER", value: "o t h e r" }];
  const noValueInArgv = (calls: Call[]) => {
    for (const c of calls) for (const v of vars) expect(c.args.join(" ")).not.toContain(v.value);
  };

  it("ssm: put-parameter --value file://(0600) 후 파일 삭제", async () => {
    const seen: { path: string; content: string; mode: number }[] = [];
    const { exec, calls } = recordingExec((c) => {
      const path = c.args[c.args.indexOf("--value") + 1].replace(/^file:\/\//, "");
      seen.push({ path, content: readFileSync(path, "utf8"), mode: statSync(path).mode & 0o777 });
      return "{}";
    });
    const r = await pushSsm({ prefix: "/app/dev", region: "ap-northeast-2" }, vars, exec);
    expect(r).toEqual({ pushed: ["API_KEY", "OTHER"], failed: [] });
    noValueInArgv(calls);
    expect(calls[0].args.slice(0, 7)).toEqual(["ssm", "put-parameter", "--name", "/app/dev/API_KEY", "--type", "SecureString", "--overwrite"]);
    expect(calls[0].opts?.input).toBeUndefined();
    expect(seen.map((x) => x.content)).toEqual([SECRET, "o t h e r"]);
    expect(seen.every((x) => x.mode === 0o600)).toBe(true);
    expect(seen.every((x) => !existsSync(x.path))).toBe(true);
  });

  it("vercel: env add --force, 값은 stdin, 빈 임시 폴더에서", async () => {
    const { exec, calls } = recordingExec();
    const r = await pushVercel({ project: "web", target: "preview", scope: "team", globalDir: "/g" }, vars, exec);
    expect(r.pushed).toEqual(["API_KEY", "OTHER"]);
    noValueInArgv(calls);
    expect(calls[0].args).toEqual(["-Q", "/g", "env", "add", "API_KEY", "preview", "--project", "web", "--force", "--yes", "--scope", "team"]);
    expect(calls.map((c) => c.opts?.input)).toEqual([SECRET, "o t h e r"]);
    expect(calls[0].opts?.cwd).toBeTruthy();
  });

  it("gha: gh secret set, 값은 stdin, 토큰 env 제거", async () => {
    process.env.GITHUB_TOKEN = "company-token";
    try {
      const { exec, calls } = recordingExec();
      await pushGha({ repo: "o/r", environment: "prod" }, vars, exec);
      noValueInArgv(calls);
      expect(calls[0].args).toEqual(["secret", "set", "API_KEY", "--repo", "o/r", "--env", "prod"]);
      expect(calls[0].opts?.input).toBe(SECRET);
      expect(calls[0].opts?.env?.GITHUB_TOKEN).toBeUndefined();
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("실패 메시지에 값이 섞여 있으면 가린다", async () => {
    const { exec } = recordingExec(() => {
      throw Object.assign(new Error("exit 1"), { stderr: `Error: invalid value ${SECRET}\n` });
    });
    const r = await pushGha({ repo: "o/r" }, [vars[0]], exec);
    expect(r.failed[0].key).toBe("API_KEY");
    expect(r.failed[0].error).not.toContain(SECRET);
    expect(r.failed[0].error).toContain("***");
  });

  describe("dotenv", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "wsenv-push-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    it("다른 줄은 보존하며 합치고 0600", () => {
      const file = join(dir, ".env");
      writeFileSync(file, "# keep\nLOCAL_ONLY=1\nAPI_KEY=old\n", { mode: 0o644 });
      expect(pushDotenv({ path: file }, vars)).toEqual({ pushed: ["API_KEY", "OTHER"], failed: [] });
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const text = readFileSync(file, "utf8");
      expect(text.startsWith("# keep\nLOCAL_ONLY=1\n")).toBe(true);
      expect(parseDotenv(text)).toEqual([{ key: "LOCAL_ONLY", value: "1" }, { key: "API_KEY", value: SECRET }, { key: "OTHER", value: "o t h e r" }]);
    });
  });
});

describe("ws env push", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsenv-push-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("계획: 원격 있음+일치=동일, 원격 없음=추가, 원격에만 있는 키는 보고만", () => {
    const vault = [
      { key: "A", sync: { t1: "match" as const } },
      { key: "B", sync: { t1: "differs" as const } },
      { key: "C", sync: { t1: "never" as const } },
      { key: "D", sync: { t1: "match" as const } },
    ];
    expect(planPush(vault, ["A", "B", "C", "D"], "t1", new Set(["A", "B", "Z"]))).toEqual({
      add: ["C", "D"], update: ["B"], same: ["A"], remoteOnly: ["Z"], remoteKnown: true,
    });
    expect(planPush(vault, ["A", "B", "C"], "t1", null)).toMatchObject({ add: ["C"], update: ["B"], same: ["A"], remoteKnown: false });
  });

  function makeApi(file: string, env = "dev", approvals: string[] = ["pending", "approved"]) {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    let polls = 0;
    const api: ApiFn = async (method, path, body) => {
      calls.push({ method, path: path.split("?")[0], body });
      if (path.startsWith("/api/env/targets?")) return { targets: [target("dotenv", { path: file }, {}, env)] };
      if (path.startsWith("/api/env?")) return { vars: [{ key: "API_KEY", sync: { t1: "never" } }, { key: "SAME", sync: { t1: "match" } }] };
      if (method === "POST" && path === "/api/env/targets/t1/push") return { opId: "o1", approvalId: "ap1", sent: true };
      if (path === "/api/approvals/ap1") return { approval: { status: approvals[Math.min(polls++, approvals.length - 1)] } };
      if (method === "POST" && path === "/api/env/push/o1/claim") return { targetId: "t1", vars: [{ key: "API_KEY", value: SECRET }] };
      if (method === "POST" && path === "/api/env/push/o1/result") return { status: "done" };
      throw new Error(`unexpected ${method} ${path}`);
    };
    return { api, calls };
  }

  it("드라이런: 이름만 출력, 쓰기 요청 없음", async () => {
    const file = join(dir, ".env");
    writeFileSync(file, `SAME=x\nREMOTE_ONLY=${SECRET}\n`);
    const { api, calls } = makeApi(file);
    const cap = captureAll();
    try {
      await envPush({ api, log: (l) => console.log(l) }, { targetId: "t1", apply: false, wait: false });
    } finally {
      cap.restore();
    }
    const t = cap.text();
    expect(t).not.toContain(SECRET);
    expect(t).toMatch(/추가 1: API_KEY/);
    expect(t).toMatch(/동일\(마지막 반영과 같음\) 1: SAME/);
    expect(t).toMatch(/원격에만 있음\(지우지 않음\) 1: REMOTE_ONLY/);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/env/targets", "GET /api/env"]);
    expect(readFileSync(file, "utf8")).toBe(`SAME=x\nREMOTE_ONLY=${SECRET}\n`);
  });

  it("--apply --wait: 승인 대기 → claim → 파일 반영(0600) → 결과는 키 이름만", async () => {
    const file = join(dir, ".env");
    writeFileSync(file, "SAME=x\n", { mode: 0o644 });
    const { api, calls } = makeApi(file);
    const sleep = vi.fn(async () => {});
    const cap = captureAll();
    try {
      await envPush({ api, log: (l) => console.log(l), sleep }, { targetId: "t1", apply: true, wait: true, channel: "C1" });
    } finally {
      cap.restore();
    }
    expect(cap.text()).not.toContain(SECRET);
    expect(cap.text()).toContain("반영 1개 · 실패 0개 (done)");
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(calls.find((c) => c.path === "/api/env/targets/t1/push")?.body).toEqual({ keys: ["API_KEY"], channel: "C1" });
    const result = calls.find((c) => c.path === "/api/env/push/o1/result")?.body;
    expect(result).toEqual({ pushed: ["API_KEY"], failed: [] });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(parseDotenv(readFileSync(file, "utf8"))).toEqual([{ key: "SAME", value: "x" }, { key: "API_KEY", value: SECRET }]);
  });

  it("--wait 없이: 승인 요청만 만들고 이어서 할 명령을 안내(claim 안 함)", async () => {
    const { api, calls } = makeApi(join(dir, ".env"));
    const lines: string[] = [];
    await envPush({ api, log: (l) => lines.push(l) }, { targetId: "t1", apply: true, wait: false });
    expect(lines.join("\n")).toContain("--op o1");
    expect(calls.some((c) => c.path.includes("/claim"))).toBe(false);
  });

  it("거부되면 claim 하지 않는다", async () => {
    const { api, calls } = makeApi(join(dir, ".env"), "dev", ["rejected"]);
    await expect(envPush({ api, log: () => {}, sleep: async () => {} }, { targetId: "t1", apply: true, wait: true })).rejects.toThrow(/rejected/);
    expect(calls.some((c) => c.path.includes("/claim"))).toBe(false);
  });

  it("운영 env 는 TTY 가 아니면 거부, TTY 면 yes 를 받아야 진행", async () => {
    const file = join(dir, ".env");
    const a = makeApi(file, "prod");
    await expect(envPush({ api: a.api, log: () => {}, isTTY: () => false }, { targetId: "t1", apply: true, wait: true })).rejects.toThrow(/터미널/);
    expect(a.calls.some((c) => c.path === "/api/env/targets/t1/push")).toBe(false);

    const b = makeApi(file, "prod");
    await expect(
      envPush({ api: b.api, log: () => {}, isTTY: () => true, prompt: async () => "no" }, { targetId: "t1", apply: true, wait: true }),
    ).rejects.toThrow(/중단/);
    expect(b.calls.some((c) => c.path === "/api/env/targets/t1/push")).toBe(false);

    const c = makeApi(file, "prod");
    await envPush({ api: c.api, log: () => {}, sleep: async () => {}, isTTY: () => true, prompt: async () => "yes" }, { targetId: "t1", apply: true, wait: true });
    expect(c.calls.some((x) => x.path === "/api/env/push/o1/result")).toBe(true);
  });

  it("--op: 승인된 작업을 이어서 claim·반영", async () => {
    const file = join(dir, ".env");
    const { api, calls } = makeApi(file);
    await envPush({ api, log: () => {} }, { targetId: "t1", apply: false, wait: false, op: "o1" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/env/targets", "POST /api/env/push/o1/claim", "POST /api/env/push/o1/result"]);
    expect(parseDotenv(readFileSync(file, "utf8"))).toEqual([{ key: "API_KEY", value: SECRET }]);
  });
});

describe("ws env drift — 값·해시는 출력·전송하지 않는다", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wsenv-drift-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const OTHER = "remote-only-secret-zzz";
  const DIFF = "remote-different-secret-yyy";

  function makeApi(t: TargetInfo, vault: { key: string; value: string; sync?: string }[]) {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const api: ApiFn = async (method, path, body) => {
      calls.push({ method, path: path.split("?")[0], body });
      if (path.startsWith("/api/env/targets?")) return { targets: [t] };
      if (path.startsWith("/api/env?")) return { vars: vault.map((v) => ({ key: v.key, sync: { t1: v.sync ?? "match" } })) };
      if (method === "POST" && path === "/api/env/pull") return { vars: vault.map(({ key, value }) => ({ key, value })) };
      if (method === "POST" && path === "/api/env/targets/t1/drift") return { counts: {} };
      if (path === "/api/projects") return PROJECTS;
      throw new Error(`unexpected ${method} ${path}`);
    };
    return { api, calls };
  }

  it("dotenv: 값 비교 → 상태만 기록, 출력·요청 본문 어디에도 값 없음", async () => {
    const file = join(dir, ".env");
    writeFileSync(file, `API_KEY=${SECRET}\nOTHER=${DIFF}\nEXTRA=${OTHER}\n`);
    const { api, calls } = makeApi(target("dotenv", { path: file }), [
      { key: "API_KEY", value: SECRET }, { key: "OTHER", value: "vault-other" }, { key: "GONE", value: "vault-gone" },
    ]);
    const cap = captureAll();
    try {
      await envDrift({ api, log: (l) => console.log(l) }, { targetId: "t1", all: false });
    } finally {
      cap.restore();
    }
    const out = cap.text();
    for (const v of [SECRET, DIFF, OTHER, "vault-other", "vault-gone"]) expect(out).not.toContain(v);
    expect(out).toMatch(/일치 1/);
    expect(out).toMatch(/다름 1: OTHER/);
    expect(out).toMatch(/원격 없음 1: GONE/);
    expect(out).toMatch(/원격에만 1: EXTRA/);
    const post = calls.find((c) => c.path === "/api/env/targets/t1/drift");
    expect(post?.body).toEqual({ results: { API_KEY: "match", EXTRA: "remote_only", GONE: "missing_remote", OTHER: "differs" } });
    // 금고 값 반출은 점검 목적으로 표시해 서버가 pull 이 아니라 drift_read 로 감사한다
    expect(calls.find((c) => c.path === "/api/env/pull")?.body).toMatchObject({ purpose: "drift" });
    for (const v of [SECRET, DIFF, OTHER, "vault-other"]) expect(JSON.stringify(post?.body)).not.toContain(v);
    // 파일은 건드리지 않는다
    expect(readFileSync(file, "utf8")).toBe(`API_KEY=${SECRET}\nOTHER=${DIFF}\nEXTRA=${OTHER}\n`);
  });

  it("ssm: --with-decryption JSON 을 메모리에서 파싱(바로 아래 단계만), 출력에 값 없음", async () => {
    const execCalls: string[][] = [];
    const exec: ExecFn = async (file, args) => {
      execCalls.push([file, ...args]);
      if (args[0] === "sts") return JSON.stringify({ Account: "123456789012" });
      return JSON.stringify({ Parameters: [{ Name: "/app/dev/API_KEY", Value: DIFF }] });
    };
    const { api, calls } = makeApi(target("ssm", { prefix: "/app/dev" }, { accountId: "123456789012" }), [{ key: "API_KEY", value: SECRET }]);
    const cap = captureAll();
    try {
      await envDrift({ api, log: (l) => console.log(l), exec }, { targetId: "t1", all: false });
    } finally {
      cap.restore();
    }
    expect(cap.text()).not.toContain(SECRET);
    expect(cap.text()).not.toContain(DIFF);
    const ssm = execCalls.find((c) => c[1] === "ssm")!;
    expect(ssm).toContain("--with-decryption");
    expect(ssm).not.toContain("--recursive");
    expect(calls.find((c) => c.path === "/api/env/targets/t1/drift")?.body).toEqual({ results: { API_KEY: "differs" } });
  });

  it("gha: 이름만(값은 받지도 않음 — pull 호출 없음), 토큰 env 제거, '마지막 반영 이후 바뀜' 신호", async () => {
    let ghEnvSeen: NodeJS.ProcessEnv | undefined;
    const exec: ExecFn = async (file, args, opts?: ExecOpts) => {
      if (file === "gh" && args[0] === "api") return "me\n";
      ghEnvSeen = opts?.env;
      return JSON.stringify([{ name: "API_KEY" }, { name: "ONLY_REMOTE" }]);
    };
    process.env.GITHUB_TOKEN = "ghp_should_not_be_used";
    const { api, calls } = makeApi(target("gha", { repo: "o/r" }, { login: "me" }), [
      { key: "API_KEY", value: SECRET, sync: "differs" }, { key: "NEW_ONE", value: "v", sync: "never" },
    ]);
    const lines: string[] = [];
    try {
      await envDrift({ api, log: (l) => lines.push(l), exec }, { targetId: "t1", all: false });
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
    expect(ghEnvSeen?.GITHUB_TOKEN).toBeUndefined();
    expect(calls.some((c) => c.path === "/api/env/pull")).toBe(false);
    expect(calls.find((c) => c.path === "/api/env/targets/t1/drift")?.body).toEqual({
      results: { API_KEY: "present", NEW_ONE: "missing_remote", ONLY_REMOTE: "remote_only" },
    });
    expect(lines.join("\n")).toMatch(/금고 값이 바뀜 1: API_KEY/);
  });

  it("계정이 다르면 기록하지 않고, --all 은 실패한 대상을 끝에 알리며 비정상 종료", async () => {
    const exec: ExecFn = async () => JSON.stringify({ Account: "999999999999" });
    const { api, calls } = makeApi(target("ssm", { prefix: "/app/dev" }, { accountId: "123456789012" }), [{ key: "API_KEY", value: SECRET }]);
    const lines: string[] = [];
    await expect(envDrift({ api, log: (l) => lines.push(l), exec }, { all: true, project: "반장", env: "dev" })).rejects.toThrow(/1개 대상/);
    expect(lines.join("\n")).toMatch(/계정이 다릅니다/);
    expect(calls.some((c) => c.path === "/api/env/pull" || c.path.endsWith("/drift"))).toBe(false);
  });

  it("대상 id 도 --all 도 없으면 오류", async () => {
    await expect(envDrift({ api: async () => ({}), log: () => {} }, { all: false })).rejects.toThrow(/--all/);
  });
});

describe("syncGroup 경고", () => {
  const groups = {
    syncGroups: [
      { name: "db", consistent: true, members: [{ projectId: "p1", projectName: "반장", env: "dev", key: "DB", varId: "v1" }] },
      {
        name: "jwt", consistent: false,
        members: [
          { projectId: "p1", projectName: "반장", env: "prod", key: "JWT", varId: "v2" },
          { projectId: "p2", projectName: "로요", env: "prod", key: "JWT_SECRET", varId: "v3" },
        ],
      },
    ],
  };
  it("env groups: 일치/불일치·멤버 이름", async () => {
    const lines: string[] = [];
    await envGroups({ api: async () => groups, log: (l) => lines.push(l) });
    const t = lines.join("\n");
    expect(t).toMatch(/일치\tdb/);
    expect(t).toMatch(/⚠ 불일치\tjwt\t2개\t반장\/prod\/JWT, 로요\/prod\/JWT_SECRET/);
    expect(t).toMatch(/1개/);
  });
  it("env ls: 이 프로젝트가 걸린 불일치 묶음을 경고, 드리프트 상태 표시", async () => {
    const lines: string[] = [];
    const api: ApiFn = async (_m, path) => {
      if (path === "/api/projects") return PROJECTS;
      if (path === "/api/env/sync-groups") return groups;
      return {
        vars: [{ id: "v2", env: "prod", key: "JWT", version: 1, valueLength: 3, syncGroup: "jwt", updatedAt: "t", updatedByName: null, sync: { t1: "match" }, drift: { t1: "differs" } }],
        envs: ["prod"], targets: [{ id: "t1", kind: "dotenv" }],
      };
    };
    await envLs({ api, log: (l) => lines.push(l) }, "반장");
    const t = lines.join("\n");
    expect(t).toContain("dotenv:일치/원격 다름");
    expect(t).toMatch(/syncGroup 'jwt' 값 불일치: 반장\/prod\/JWT, 로요\/prod\/JWT_SECRET/);
  });
});

describe("ws env target ls — 세션 주입 미리보기(P3c)", () => {
  const T = { id: "t1", projectId: "p1", env: "dev", kind: "ssm", config: { prefix: "/acme/dev", profile: "acme" }, account: { accountId: "123456789012" }, summary: "/acme/dev", accountSummary: "AWS 123456789012", lastPushedAt: null };
  const run = async (env?: string) => {
    const lines: string[] = [];
    const api: ApiFn = async (_m, path) => (path === "/api/projects" ? PROJECTS : { targets: [T] });
    await envTargetLs({ api, log: (l: string) => void lines.push(l) } as Parameters<typeof envTargetLs>[0], "반장", env);
    return lines.join("\n");
  };
  it("env 필터가 없으면 /api/context 에 들어갈 계정 줄을 보여 준다", async () => {
    expect(await run()).toContain("세션 주입 미리보기:\n## 계정 (env 금고 반영 대상)\n- AWS: 계정 123456789012 · 프로필 acme (SSM /acme/dev)");
  });
  it("env 필터가 있으면 미리보기를 생략한다(주입은 프로젝트 전체 기준)", async () => {
    expect(await run("dev")).not.toContain("미리보기");
  });
});
