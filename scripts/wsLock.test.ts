import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CHAINED, HOOK_MARKER, HOOK_SCRIPT, holderContext, installPrePushHook, lockPath, ttlOf } from "./wsLock";

// ws lock install-hook(Console 4): 임시 git 저장소에 설치·이어 부르기·hooksPath 거부·워크트리·실제 푸시.
const HOOK_SRC = resolve(__dirname, "hooks", "git-pre-push.mjs");
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
};
let root: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
function repo(name: string): string {
  const dir = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "main", dir], { env: GIT_ENV });
  writeFileSync(join(dir, "a.txt"), "a");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "wslock-")));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("ttlOf · lockPath · holderContext", () => {
  it("--ttl 범위", () => {
    expect(ttlOf(undefined)).toBeUndefined();
    expect(ttlOf("2h")).toBe(120);
    expect(() => ttlOf("5h")).toThrow(/4시간/);
    expect(() => ttlOf("soon")).toThrow();
  });
  it("이름은 한 경로 세그먼트로 인코딩", () => expect(lockPath("banjang/develop")).toBe("/api/locks/banjang%2Fdevelop"));
  it("보유자: 세션 env·INIT_CWD 의 브랜치", () => {
    const dir = repo("holder");
    git(dir, "checkout", "-qb", "develop");
    expect(holderContext({ INIT_CWD: dir, CLAUDE_CODE_SESSION_ID: "s1" })).toEqual({ session: "s1", cwd: dir, branch: "develop" });
    expect(holderContext({ CLAUDE_SESSION_ID: "s0", CLAUDE_CODE_SESSION_ID: "s1" }, dir).session).toBe("s0");
    expect(holderContext({}, root).branch).toBeUndefined(); // 저장소 아님
  });
});

describe("installPrePushHook", { timeout: 30000 }, () => {
  it("새로 설치: 래퍼(실행 가능)·훅 본문 복사, 이어 부를 훅 없음", () => {
    const dir = repo("fresh");
    const r = installPrePushHook(dir, HOOK_SRC);
    const hooks = join(dir, ".git", "hooks");
    expect(r).toMatchObject({ hooksDir: hooks, chained: false, updated: false });
    expect(readFileSync(join(hooks, "pre-push"), "utf8")).toContain(HOOK_MARKER);
    expect(statSync(join(hooks, "pre-push")).mode & 0o111).toBeTruthy();
    expect(readFileSync(join(hooks, HOOK_SCRIPT), "utf8")).toBe(readFileSync(HOOK_SRC, "utf8"));
  });

  it("기존 pre-push 는 보존해 이어 부르고, 다시 설치해도 두 번 옮기지 않는다", () => {
    const dir = repo("chain");
    const hooks = join(dir, ".git", "hooks");
    writeFileSync(join(hooks, "pre-push"), "#!/bin/sh\necho theirs\n");
    chmodSync(join(hooks, "pre-push"), 0o755);
    expect(installPrePushHook(dir, HOOK_SRC)).toMatchObject({ chained: true, updated: false });
    expect(readFileSync(join(hooks, CHAINED), "utf8")).toContain("echo theirs");
    expect(installPrePushHook(dir, HOOK_SRC)).toMatchObject({ chained: true, updated: true });
    expect(readFileSync(join(hooks, CHAINED), "utf8")).toContain("echo theirs");
  });

  it("core.hooksPath 레포는 덮어쓰지 않고 방법을 알려 준다", () => {
    const dir = repo("hookspath");
    git(dir, "config", "core.hooksPath", ".githooks");
    expect(() => installPrePushHook(dir, HOOK_SRC)).toThrow(/core\.hooksPath/);
    expect(existsSync(join(dir, ".git", "hooks", HOOK_SCRIPT))).toBe(false);
    expect(existsSync(join(dir, ".githooks"))).toBe(false);
  });

  it("git 저장소가 아니면 거부", () => expect(() => installPrePushHook(join(root), HOOK_SRC)).toThrow(/git 저장소가 아닙니다/));

  it("워크트리에서 설치해도 본체(공통) hooks 에 들어간다", () => {
    const dir = repo("wt-main");
    const wt = join(root, "wt-linked");
    git(dir, "worktree", "add", "-q", "-b", "feat", wt);
    const r = installPrePushHook(wt, HOOK_SRC);
    expect(r.hooksDir).toBe(join(dir, ".git", "hooks"));
  });
});

describe("실제 푸시(bare 원격)", { timeout: 30000 }, () => {
  function setup(name: string, theirs: string | null) {
    const remote = join(root, `${name}-remote.git`);
    execFileSync("git", ["init", "-q", "--bare", remote], { env: GIT_ENV });
    const dir = repo(name);
    git(dir, "remote", "add", "origin", remote);
    const hooks = join(dir, ".git", "hooks");
    if (theirs !== null) {
      writeFileSync(join(hooks, "pre-push"), theirs);
      chmodSync(join(hooks, "pre-push"), 0o755);
    }
    installPrePushHook(dir, HOOK_SRC);
    return dir;
  }
  // 닿지 않는 서버 + 토큰 → 우리 훅은 실패를 삼키고(fail open) 통과해야 한다
  const pushEnv = { ...GIT_ENV, WS_BASE: "http://127.0.0.1:9", WS_TOKEN: "wst_test", HOME: "/nonexistent-home" };
  const push = (dir: string) => spawnSync("git", ["-C", dir, "push", "-q", "origin", "main"], { encoding: "utf8", env: pushEnv, timeout: 20000 });

  it("서버가 없어도 푸시는 성공하고, 기존 훅은 같은 stdin 을 받는다", () => {
    const seen = join(root, "seen.txt");
    const dir = setup("push-ok", `#!/bin/sh\ncat > "${seen}"\nexit 0\n`);
    const r = push(dir);
    expect(r.status).toBe(0);
    expect(readFileSync(seen, "utf8")).toMatch(/^refs\/heads\/main [0-9a-f]{40} refs\/heads\/main 0{40}/);
  });

  it("기존 훅이 실패하면 그 결과는 그대로(우리는 막지도 풀지도 않는다)", () => {
    const dir = setup("push-theirs-fail", "#!/bin/sh\nexit 1\n");
    expect(push(dir).status).not.toBe(0);
  });

  it("기존 훅이 없으면 우리 훅만 돌고 통과", () => {
    const dir = setup("push-solo", null);
    expect(push(dir).status).toBe(0);
  });
});
