import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LESSON_ROLES } from "@/lib/lessonPromptMatch";
import { ROLE_AGENTS, buildContext, errorLine, hookOutput, lessonsUrl, roleOf, rolePromptBody, run } from "./teamspace-subagent-start.mjs";

const cfg = { base: "http://ws.test", token: "wst_x" };
const input = { session_id: "S", cwd: "/r", agent_id: "a1", agent_type: "implementer", hook_event_name: "SubagentStart" };
const ctxOf = (out: string) => JSON.parse(out).hookSpecificOutput.additionalContext as string;

describe("teamspace-subagent-start — 순수 부분", () => {
  it("역할 판정 — 역할 이름 그대로이거나 <이름>-<역할>", () => {
    for (const t of ["implementer", "reviewer", "researcher"]) expect(roleOf(t)).toBe(t);
    expect(roleOf("gate-implementer")).toBe("implementer");
    expect(roleOf("today-reviewer")).toBe("reviewer");
    expect(roleOf("a-b-researcher")).toBe("researcher");
    for (const t of ["general-purpose", "Explore", "implementerx", "implementer-helper", "xreviewer", "-", "", undefined]) expect(roleOf(t)).toBe(null);
  });
  it("role 레슨 요청 본문·세션 레포 레슨 URL", () => {
    expect(rolePromptBody(input, "implementer")).toEqual({ prompt: "role:implementer", cwd: "/r", sessionId: "S", exclude: [] });
    expect(lessonsUrl("http://b", "/a b")).toBe("http://b/api/context?compact=1&sections=lessons&via=SubagentStart&cwd=%2Fa%20b");
  });
  it("두 조각을 teamspace-context 블록으로 묶고, 둘 다 비면 빈 문자열", () => {
    expect(buildContext({ base: "http://b", role: "reviewer", agentType: "today-reviewer", parts: ["## role", "## repo"] })).toBe(
      '<teamspace-context source="http://b" agent="reviewer" agent_type="today-reviewer">\n## role\n\n## repo\n</teamspace-context>',
    );
    expect(buildContext({ base: "http://b", role: "reviewer", agentType: "reviewer", parts: ["", "  "] })).toBe("");
  });
  it("오류는 한 줄 — 줄바꿈·꺾쇠는 지운다", () => {
    expect(errorLine("implementer", "role: HTTP 500\n<x>")).toBe('<teamspace-context-error agent="implementer">role: HTTP 500 x</teamspace-context-error>');
  });
  it("출력은 SubagentStart hookSpecificOutput.additionalContext", () => {
    expect(JSON.parse(hookOutput("X"))).toEqual({ hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: "X" } });
  });
});

type Call = { url: string; method: string; body?: unknown };
function fakeFetch(handler: (c: Call) => Response | Promise<Response>, calls: Call[] = []) {
  return (async (url: string, init: RequestInit = {}) => {
    const c = { url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    return handler(c);
  }) as unknown as typeof fetch;
}
const jsonRes = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
const textRes = (t: string) => new Response(t, { headers: { "content-type": "text/markdown" } });

describe("teamspace-subagent-start — run()", () => {
  it("role 레슨(POST /api/context/prompt) + 세션 레포 레슨(GET sections=lessons)을 한 블록으로", async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch((c) => (c.method === "POST" ? jsonRes({ markdown: "## role 레슨 `r1`", lessonIds: ["r1"] }) : textRes("## 팀 작업규칙·레슨 `p1`")), calls);
    const ctx = ctxOf(await run(input, { fetchImpl, cfg }));
    expect(ctx.startsWith('<teamspace-context source="http://ws.test" agent="implementer" agent_type="implementer">\n')).toBe(true);
    expect(ctx).toContain("`r1`");
    expect(ctx).toContain("`p1`");
    expect(ctx).not.toContain("teamspace-context-error");
    expect(calls).toEqual([
      { url: "http://ws.test/api/context/prompt", method: "POST", body: { prompt: "role:implementer", cwd: "/r", sessionId: "S", exclude: [] } },
      { url: "http://ws.test/api/context?compact=1&sections=lessons&via=SubagentStart&cwd=%2Fr", method: "GET", body: undefined },
    ]);
  });

  it("이름 붙인 에이전트(<이름>-<역할>)는 역할로 요청하고 원래 agent_type 은 따로 싣는다", async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch((c) => (c.method === "POST" ? jsonRes({ markdown: "## role `r1`" }) : textRes("## repo `p1`")), calls);
    const ctx = ctxOf(await run({ ...input, agent_type: "gate-implementer" }, { fetchImpl, cfg }));
    expect(ctx.startsWith('<teamspace-context source="http://ws.test" agent="implementer" agent_type="gate-implementer">\n')).toBe(true);
    expect(calls[0].body).toEqual({ prompt: "role:implementer", cwd: "/r", sessionId: "S", exclude: [] });
  });

  it("역할 에이전트가 아니면 네트워크 없이 빈 출력", async () => {
    const calls: Call[] = [];
    const fetchImpl = fakeFetch(() => jsonRes({}), calls);
    expect(await run({ ...input, agent_type: "general-purpose" }, { fetchImpl, cfg })).toBe("");
    expect(await run({ ...input, agent_type: undefined }, { fetchImpl, cfg })).toBe("");
    expect(await run({ ...input, agent_type: "implementer-helper" }, { fetchImpl, cfg })).toBe("");
    expect(calls).toEqual([]);
  });

  it("한쪽 실패 — 성공한 쪽은 싣고 실패는 한 줄 오류로", async () => {
    const fetchImpl = fakeFetch((c) => (c.method === "POST" ? new Response("no", { status: 500 }) : textRes("## repo `p1`")));
    const ctx = ctxOf(await run(input, { fetchImpl, cfg }));
    expect(ctx).toContain("`p1`");
    expect(ctx).toContain('<teamspace-context-error agent="implementer">role: HTTP 500</teamspace-context-error>');
  });

  it("둘 다 실패 → 오류 한 줄만(fail open)", async () => {
    const fetchImpl = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const ctx = ctxOf(await run(input, { fetchImpl, cfg }));
    expect(ctx).toBe('<teamspace-context-error agent="implementer">role: fetch failed; repo: fetch failed</teamspace-context-error>');
  });

  it("토큰 없음 → 네트워크 없이 오류 한 줄", async () => {
    const calls: Call[] = [];
    const ctx = ctxOf(await run(input, { fetchImpl: fakeFetch(() => jsonRes({}), calls), cfg: { ...cfg, token: "" } }));
    expect(ctx).toBe('<teamspace-context-error agent="implementer">no token (~/.claude/teamspace.json or WS_TOKEN)</teamspace-context-error>');
    expect(calls).toEqual([]);
  });

  it("둘 다 비면 빈 출력", async () => {
    const fetchImpl = fakeFetch((c) => (c.method === "POST" ? jsonRes({ markdown: "" }) : textRes("")));
    expect(await run(input, { fetchImpl, cfg })).toBe("");
  });
});

function spawnHook(stdin: string, env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(__dirname, "teamspace-subagent-start.mjs")], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
    p.stdin.end(stdin);
  });
}

describe("teamspace-subagent-start — 프로세스", () => {
  it("가짜 서버 두 경로를 불러 additionalContext JSON 을 낸다", async () => {
    const seen: string[] = [];
    const srv = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers["x-ws-token"]}`);
      req.resume();
      req.on("end", () => {
        if (req.method === "POST") {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ markdown: "## role `rx`", lessonIds: ["rx"] }));
        } else {
          res.setHeader("content-type", "text/markdown");
          res.end("## repo `px`");
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    const dir = mkdtempSync(join(tmpdir(), "ss-"));
    try {
      const r = await spawnHook(JSON.stringify({ ...input, cwd: dir, agent_type: "today-reviewer" }), { WS_BASE: `http://127.0.0.1:${port}`, WS_TOKEN: "wst_test" });
      expect(r.code).toBe(0);
      const ctx = ctxOf(r.out);
      expect(ctx).toContain('agent="reviewer" agent_type="today-reviewer"');
      expect(ctx).toContain("`rx`");
      expect(ctx).toContain("`px`");
      expect(seen.sort()).toEqual([
        `GET /api/context?compact=1&sections=lessons&via=SubagentStart&cwd=${encodeURIComponent(dir)} wst_test`,
        "POST /api/context/prompt wst_test",
      ]);
    } finally {
      srv.close();
    }
  });

  it("서버가 없으면 오류 한 줄, 종료 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ss-"));
    const r = await spawnHook(JSON.stringify({ ...input, cwd: dir }), { WS_BASE: "http://127.0.0.1:9", WS_TOKEN: "wst_test" });
    expect(r.code).toBe(0);
    expect(ctxOf(r.out)).toMatch(/^<teamspace-context-error agent="implementer">role: .+; repo: .+<\/teamspace-context-error>$/);
  });

  it("범용 에이전트·깨진 stdin 은 출력 없음", async () => {
    expect((await spawnHook(JSON.stringify({ ...input, agent_type: "general-purpose" }), { WS_BASE: "http://127.0.0.1:9", WS_TOKEN: "t" })).out).toBe("");
    expect((await spawnHook("{not json", { WS_BASE: "http://127.0.0.1:9", WS_TOKEN: "t" })).out).toBe("");
  });
});

// 훅은 전역 사본(~/.claude/hooks)으로도 돌아 lib 를 import 할 수 없다 — 사본 목록이 서버 판정과 같은지 여기서 묶는다.
describe("ROLE_AGENTS", () => {
  it("lib/lessonPromptMatch 의 LESSON_ROLES(role: 가산점 대상)와 같다", () => {
    expect(ROLE_AGENTS).toEqual(LESSON_ROLES);
  });
});
