import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HEARTBEAT_INTERVAL_MS,
  claimHeartbeat,
  cwdTargetsFromCommand,
  extractPaths,
  heartbeatStateFile,
  pickProject,
  projectContextUrl,
  resolveRule,
  roleOf,
  ROLE_AGENTS,
  sessionContextMarkerFile,
  wantsDelta,
  work,
} from "./teamspace-project-context.mjs";

// 라이브 세션 보드 하트비트: 세션당 10분에 1번만.
describe("claimHeartbeat", () => {
  const dir = mkdtempSync(join(tmpdir(), "hb-"));
  it("첫 호출은 차례, 10분 안은 아님, 10분 지나면 다시 차례", () => {
    const f = heartbeatStateFile("sess/1:x", dir);
    expect(f).toBe(join(dir, "teamspace-heartbeat-sess_1_x.json"));
    const t = 1_000_000_000_000;
    expect(claimHeartbeat(f, t)).toBe(true);
    expect(claimHeartbeat(f, t + 60_000)).toBe(false);
    expect(claimHeartbeat(f, t + HEARTBEAT_INTERVAL_MS - 1)).toBe(false);
    expect(claimHeartbeat(f, t + HEARTBEAT_INTERVAL_MS)).toBe(true);
  });
  it("깨진 상태 파일은 첫 호출로 본다", () => {
    const f = heartbeatStateFile("broken", dir);
    writeFileSync(f, "{not json");
    expect(claimHeartbeat(f, Date.now())).toBe(true);
  });
  it("기록할 수 없으면 보내지 않는다(매 호출 발송 방지)", () => {
    expect(claimHeartbeat(join(dir, "no-such-dir", "x.json"), Date.now())).toBe(false);
  });
});

// PostToolUse 훅: 세션 cwd 밖 프로젝트 경로를 건드리면 그 프로젝트 컨텍스트를 한 번 주입한다.
const rules = [
  { cwdPrefix: "/Users/u/dev/banjang", projectId: "bj", priority: 10 },
  { cwdPrefix: "/Users/u/dev/teamspace", projectId: "ts", priority: 10 },
  { cwdPrefix: "/Users/u/dev", projectId: null, priority: 0 },
];

describe("extractPaths", () => {
  it("file_path·path·notebook_path 를 cwd 기준 절대경로로 만든다", () => {
    expect(extractPaths({ file_path: "/a/b.ts" }, "/cwd")).toEqual(["/a/b.ts"]);
    expect(extractPaths({ path: "src" }, "/cwd")).toEqual(["/cwd/src"]);
    expect(extractPaths({ notebook_path: "~/n.ipynb" }, "/cwd", "/Users/u")).toEqual(["/Users/u/n.ipynb"]);
  });

  // Bash command 는 작업 디렉터리를 바꾸는 대상(cd·git -C·--cwd)만, 그것도 실제 디렉터리일 때만 본다.
  const dirs = new Set(["/Users/u/dev/banjang", "/Users/u/dev/teamspace", "/cwd/sub", "/Users/u"]);
  const isDir = (p: string) => dirs.has(p);

  it("Bash command 의 cd·git -C·--cwd 대상을 뽑는다(따옴표·~·상대경로)", () => {
    expect(extractPaths({ command: "cd ~/dev/banjang && pnpm test" }, "/cwd", "/Users/u", isDir)).toEqual(["/Users/u/dev/banjang"]);
    expect(extractPaths({ command: `cd "/Users/u/dev/banjang" && ls` }, "/cwd", "/Users/u", isDir)).toEqual(["/Users/u/dev/banjang"]);
    expect(extractPaths({ command: "git -C '/Users/u/dev/teamspace' status" }, "/cwd", "/Users/u", isDir)).toEqual(["/Users/u/dev/teamspace"]);
    expect(extractPaths({ command: "pnpm --cwd sub run build" }, "/cwd", "/Users/u", isDir)).toEqual(["/cwd/sub"]);
    expect(extractPaths({ command: "pnpm --cwd=/Users/u/dev/banjang run build" }, "/cwd", "/Users/u", isDir)).toEqual(["/Users/u/dev/banjang"]);
    expect(extractPaths({ command: "cd ~ && ls" }, "/cwd", "/Users/u", isDir)).toEqual(["/Users/u"]);
  });

  it("존재하지 않는 디렉터리·파일 경로는 무시한다", () => {
    expect(extractPaths({ command: "cd /Users/u/dev/nope && ls" }, "/cwd", "/Users/u", isDir)).toEqual([]);
    expect(extractPaths({ command: "cd /Users/u/dev/banjang/a.ts" }, "/cwd", "/Users/u", isDir)).toEqual([]);
  });

  it("인자·URL 에 스친 경로는 무시한다(리뷰 A-2: 어디에나 있는 디렉터리라도)", () => {
    const any = () => true;
    expect(extractPaths({ command: "grep foo /Users/ljun/dev/ljun/banjang/x.ts" }, "/cwd", "/Users/u", any)).toEqual([]);
    expect(extractPaths({ command: `cat "/Users/u/dev/banjang/a.ts" | grep -n foo src/x` }, "/cwd", "/Users/u", any)).toEqual([]);
    expect(extractPaths({ command: "curl https://x.io/Users/u/dev/banjang && cat ~/dev/banjang/AGENTS.md" }, "/cwd", "/Users/u", any)).toEqual([]);
    expect(extractPaths({ command: "cd - && cd && abcd /Users/u/dev/banjang" }, "/cwd", "/Users/u", any)).toEqual([]);
  });

  it("cwdTargetsFromCommand 는 원 토큰을 따옴표만 벗겨 돌려준다", () => {
    expect(cwdTargetsFromCommand(`cd "a b" && git -C 'c' log; pnpm --cwd=d t`)).toEqual(["a b", "c", "d"]);
    expect(cwdTargetsFromCommand(undefined)).toEqual([]);
  });

  it("루트 '/' 단독과 입력 없음은 무시한다", () => {
    expect(extractPaths({ command: "ls / && echo a/b" }, "/cwd")).toEqual([]);
    expect(extractPaths(undefined, "/cwd")).toEqual([]);
  });
});

// 주입 실패는 세션당 한 번만 보이고(에러 한 줄), 이후는 조용히 fail-open.
describe("work — 주입 실패 한 줄 표시", () => {
  const cwd = "/Users/u/dev/teamspace";
  const conf = { base: "http://h", token: "t" };
  const ok = (body: unknown, text = "") => ({ ok: true, status: 200, json: async () => body, text: async () => text });
  const run = async (fetchFn: (url: string) => Promise<unknown>, input: object, c = conf, stateDir = mkdtempSync(join(tmpdir(), "pc-"))) => {
    const out: string[] = [];
    await work({ session_id: "s1", ...input }, cwd, { fetchFn, stateDir, conf: c, write: (s: string) => out.push(s) });
    return { out, stateDir };
  };
  const touch = { tool_input: { file_path: "/Users/u/dev/banjang/y.ts" } };
  const rulesThenThrow = async (url: string) => {
    if (url.includes("/api/route-rules")) return ok({ rules });
    throw new Error("ECONNREFUSED");
  };

  it("컨텍스트 요청이 실패하면 에러 한 줄, 같은 세션의 다음 호출엔 안 보인다", async () => {
    const { out, stateDir } = await run(rulesThenThrow, touch);
    expect(out).toHaveLength(1);
    const ctx = JSON.parse(out[0]).hookSpecificOutput.additionalContext as string;
    expect(ctx).toMatch(/^<teamspace-context-error cwd="\/Users\/u\/dev\/banjang">TeamSpace 프로젝트 컨텍스트 주입 실패: .*ECONNREFUSED.* — 레슨은 pnpm ws lesson ls --project 로 직접 본다<\/teamspace-context-error>$/);
    const again = await run(rulesThenThrow, touch, conf, stateDir);
    expect(again.out).toEqual([]);
    const state = JSON.parse(readFileSync(join(stateDir, "teamspace-project-context-s1-main.json"), "utf8"));
    expect(state.errorShown).toBe(true);
  });

  it("빈 응답·non-ok 도 실패로 본다", async () => {
    const empty = async (url: string) => (url.includes("/api/route-rules") ? ok({ rules }) : ok(null, "  \n"));
    expect((await run(empty, touch)).out[0]).toContain("teamspace-context-error");
    const bad = async (url: string) => (url.includes("/api/route-rules") ? ok({ rules }) : { ok: false, status: 500, text: async () => "" });
    expect((await run(bad, touch)).out[0]).toContain("HTTP 500");
  });

  // 토큰 없음은 설정 상태지 주입 실패가 아니다 — 형제 훅(teamspace-context·prompt-lessons)처럼 조용히 끝난다.
  it("토큰이 없으면 매핑 여부와 무관하게 아무것도 내지 않고 요청도 안 한다", async () => {
    const never = async () => { throw new Error("should not fetch"); };
    const noToken = { base: "http://h", token: "" };
    expect((await run(never, { tool_input: { file_path: "/tmp/x" } }, noToken)).out).toEqual([]);
    expect((await run(never, touch, noToken)).out).toEqual([]);
  });

  it("서버가 죽어 규칙을 못 받았고 캐시도 없으면 조용히 끝난다(매핑을 모르므로)", async () => {
    const down = async () => { throw new Error("ECONNREFUSED"); };
    expect((await run(down, { tool_input: { file_path: "/tmp/x" } })).out).toEqual([]);
    expect((await run(down, touch)).out).toEqual([]);
  });

  it("매핑된 경로를 건드리지 않았으면 아무것도 내지 않는다", async () => {
    expect((await run(rulesThenThrow, { tool_input: { file_path: "/tmp/x" } })).out).toEqual([]);
    expect((await run(rulesThenThrow, { tool_input: { file_path: `${cwd}/a.ts` } })).out).toEqual([]);
  });

  it("성공하면 컨텍스트를 주입하고 에러는 없다", async () => {
    const good = async (url: string) => (url.includes("/api/route-rules") ? ok({ rules }) : ok(null, "# 반장 레슨"));
    const { out } = await run(good, touch);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("<teamspace-context ");
    expect(out[0]).toContain("반장 레슨");
  });
});

describe("resolveRule", () => {
  it("priority 우선, 동률이면 긴 접두사, projectId 없는 규칙은 제외", () => {
    expect(resolveRule("/Users/u/dev/banjang-wt-x/a", rules)?.projectId).toBe("bj");
    expect(resolveRule("/Users/u/dev/other", rules)).toBeNull();
  });
});

describe("pickProject", () => {
  it("시작 프로젝트와 다른 매핑 프로젝트를 고른다", () => {
    const p = pickProject(["/Users/u/dev/teamspace/x", "/Users/u/dev/banjang/y"], rules, { baseProjectId: "ts", injected: [] });
    expect(p).toEqual({ projectId: "bj", cwdPrefix: "/Users/u/dev/banjang" });
  });

  it("이미 주입했거나 매핑이 없으면 null", () => {
    expect(pickProject(["/Users/u/dev/banjang/y"], rules, { baseProjectId: "ts", injected: ["bj"] })).toBeNull();
    expect(pickProject(["/tmp/x"], rules, { baseProjectId: "ts", injected: [] })).toBeNull();
  });
});

describe("projectContextUrl", () => {
  it("via=PostToolUse 를 붙인다(서버 레슨 주입 기록용)", () =>
    expect(projectContextUrl("http://h", "/dev/banjang")).toBe("http://h/api/context?format=md&compact=1&via=PostToolUse&cwd=%2Fdev%2Fbanjang"));
  it("delta 면 sections=project(델타)", () =>
    expect(projectContextUrl("http://h", "/dev/banjang", { delta: true })).toBe("http://h/api/context?format=md&sections=project&via=PostToolUse&cwd=%2Fdev%2Fbanjang"));
});

// 델타(sections=project)는 세션 시작 주입을 받은 쪽에만 — 메인 세션과 SubagentStart 레슨을 받은 역할 에이전트.
describe("wantsDelta · roleOf", () => {
  it("메인 세션(agent_id 없음)은 델타", () => expect(wantsDelta({ session_id: "s" })).toBe(true));
  it("역할 에이전트(이름 그대로·<이름>-<역할>)는 델타", () => {
    expect(wantsDelta({ agent_id: "a1", agent_type: "implementer" })).toBe(true);
    expect(wantsDelta({ agent_id: "a1", agent_type: "gate-reviewer" })).toBe(true);
  });
  it("역할이 아닌 서브에이전트·agent_type 모름은 compact 그대로", () => {
    expect(wantsDelta({ agent_id: "a1", agent_type: "Explore" })).toBe(false);
    expect(wantsDelta({ agent_id: "a1", agent_type: "implementer-helper" })).toBe(false);
    expect(wantsDelta({ agent_id: "a1" })).toBe(false);
  });
  it("ROLE_AGENTS·roleOf 는 SubagentStart 훅 사본과 같다", async () => {
    const sub = await import("./teamspace-subagent-start.mjs");
    expect(ROLE_AGENTS).toEqual(sub.ROLE_AGENTS);
    for (const t of ["implementer", "x-researcher", "xreviewer", "", undefined]) expect(roleOf(t)).toBe(sub.roleOf(t));
  });
});

describe("work — 델타 URL·폴백", () => {
  const cwd = "/Users/u/dev/teamspace";
  const conf = { base: "http://h", token: "t" };
  const touch = { tool_input: { file_path: "/Users/u/dev/banjang/y.ts" } };
  const ok = (body: unknown, text = "") => ({ ok: true, status: 200, json: async () => body, text: async () => text });
  // marked = SessionStart 훅이 이 세션에 시작 컨텍스트를 넣었다는 표지(teamspace-context.mjs markSessionContext) — 기본은 있음.
  const go = async (input: object, ctx: (url: string) => unknown, { marked = true } = {}) => {
    const urls: string[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const out: string[] = [];
    const fetchFn = async (url: string, init?: { signal?: AbortSignal }) => {
      urls.push(url);
      if (url.includes("/api/context")) signals.push(init?.signal);
      return url.includes("/api/route-rules") ? ok({ rules }) : ctx(url);
    };
    const stateDir = mkdtempSync(join(tmpdir(), "pd-"));
    if (marked) writeFileSync(sessionContextMarkerFile("s1", stateDir), JSON.stringify({ at: 1, mode: "full" }));
    await work({ session_id: "s1", ...input }, cwd, { fetchFn, stateDir, conf, write: (s: string) => out.push(s) });
    return { urls: urls.filter((u) => u.includes("/api/context")), signals, ctx: out.map((o) => JSON.parse(o).hookSpecificOutput.additionalContext as string) };
  };

  it("메인 세션은 sections=project 를 부르고, 안내는 델타·전역 규칙은 이미 있음", async () => {
    const r = await go(touch, () => ok(null, "# 델타"));
    expect(r.urls).toEqual([projectContextUrl("http://h", "/Users/u/dev/banjang", { delta: true })]);
    expect(r.ctx[0]).toContain("델타");
    expect(r.ctx[0]).toContain("전역 규칙은 이미 이 세션에 있다");
  });

  it("역할 아닌 서브에이전트는 compact", async () => {
    const r = await go({ ...touch, agent_id: "a1", agent_type: "Explore" }, () => ok(null, "# 전체"));
    expect(r.urls).toEqual([projectContextUrl("http://h", "/Users/u/dev/banjang")]);
    expect(r.ctx[0]).not.toContain("델타");
  });

  it("서버가 sections=project 를 몰라 400 이면 compact 로 한 번 다시", async () => {
    const r = await go(touch, (url) => (url.includes("sections=project") ? { ok: false, status: 400, text: async () => "" } : ok(null, "# 전체")));
    expect(r.urls).toEqual([projectContextUrl("http://h", "/Users/u/dev/banjang", { delta: true }), projectContextUrl("http://h", "/Users/u/dev/banjang")]);
    expect(r.ctx[0]).toContain("# 전체");
    expect(r.ctx[0]).not.toContain("델타");
  });

  it("400 폴백은 델타 요청과 같은 신호(전체 3초 한 예산)를 쓴다 — 최악도 ≈3초", async () => {
    const r = await go(touch, (url) => (url.includes("sections=project") ? { ok: false, status: 400, text: async () => "" } : ok(null, "# 전체")));
    expect(r.signals).toHaveLength(2);
    expect(r.signals[0]).toBeInstanceOf(AbortSignal);
    expect(r.signals[1]).toBe(r.signals[0]);
  });

  it("메인 세션인데 세션 시작 표지가 없으면(SessionStart 실패) 델타 대신 compact 전체, 안내도 그렇게", async () => {
    const r = await go(touch, () => ok(null, "# 전체"), { marked: false });
    expect(r.urls).toEqual([projectContextUrl("http://h", "/Users/u/dev/banjang")]);
    expect(r.ctx[0]).toContain("세션 시작 컨텍스트가 없어");
    expect(r.ctx[0]).not.toContain("전역 규칙은 이미 이 세션에 있다");
  });

  it("역할 에이전트는 세션 시작 표지와 무관하게 델타(SubagentStart 가 넣는다)", async () => {
    const r = await go({ ...touch, agent_id: "a1", agent_type: "gate-implementer" }, () => ok(null, "# 델타"), { marked: false });
    expect(r.urls).toEqual([projectContextUrl("http://h", "/Users/u/dev/banjang", { delta: true })]);
  });

  it("400 이 아닌 실패는 폴백하지 않는다(에러 한 줄)", async () => {
    const r = await go(touch, () => ({ ok: false, status: 500, text: async () => "" }));
    expect(r.urls).toHaveLength(1);
    expect(r.ctx[0]).toContain("HTTP 500");
  });
});
