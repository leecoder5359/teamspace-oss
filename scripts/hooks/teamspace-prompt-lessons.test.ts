import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookOutput, promptStateFile, readState, run, worthAsking } from "./teamspace-prompt-lessons.mjs";

const cfg = { base: "http://ws.test", token: "wst_x" };
const okRes = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;

describe("teamspace-prompt-lessons — 순수 부분", () => {
  it("상태 파일 경로는 세션·에이전트별, 위험 문자는 _", () => {
    expect(promptStateFile("s/1:x", undefined, "/t")).toBe("/t/teamspace-prompt-lessons-s_1_x-main.json");
    expect(promptStateFile("s1", "ag", "/t")).toBe("/t/teamspace-prompt-lessons-s1-ag.json");
  });
  it("깨진 상태는 빈 상태", () => {
    const dir = mkdtempSync(join(tmpdir(), "pl-"));
    const f = join(dir, "x.json");
    writeFileSync(f, "{oops");
    expect(readState(f)).toEqual({ injected: [] });
    expect(readState(join(dir, "none.json"))).toEqual({ injected: [] });
  });
  it("짧은 메시지는 묻지 않는다", () => {
    expect(worthAsking("ㅇㅇ")).toBe(false);
    expect(worthAsking("  계 속  ")).toBe(false);
    expect(worthAsking("반장 도면 고치자")).toBe(true);
    expect(worthAsking(undefined)).toBe(false);
  });
  it("출력은 UserPromptSubmit hookSpecificOutput.additionalContext", () => {
    const j = JSON.parse(hookOutput("## 레슨", "http://b"));
    expect(j).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: '<teamspace-lessons source="http://b">\n## 레슨\n</teamspace-lessons>' } });
  });
});

describe("teamspace-prompt-lessons — run()", () => {
  it("이미 넣은 레슨을 exclude 로 보내고, 새로 넣은 id 를 상태에 더한다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pl-"));
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return okRes({ markdown: "## 관련 레슨\n- **a** `l1`", lessonIds: ["l1"], projectIds: [] });
    }) as unknown as typeof fetch;
    const input = { prompt: "prisma 마이그레이션 추가", session_id: "S", cwd: "/r" };
    const out1 = await run(input, { fetchImpl, stateDir: dir, cfg });
    expect(JSON.parse(out1).hookSpecificOutput.additionalContext).toContain("`l1`");
    expect(calls[0]).toEqual({ url: "http://ws.test/api/context/prompt", body: { prompt: input.prompt, cwd: "/r", sessionId: "S", exclude: [] } });
    await run(input, { fetchImpl, stateDir: dir, cfg });
    expect(calls[1].body.exclude).toEqual(["l1"]);
    expect(JSON.parse(readFileSync(promptStateFile("S", undefined, dir), "utf8"))).toEqual({ injected: ["l1"] });
  });

  it("빈 markdown·실패 응답·네트워크 오류·토큰 없음 → 출력 없음(fail open)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pl-"));
    const input = { prompt: "prisma 마이그레이션 추가", session_id: "S2", cwd: "/r" };
    expect(await run(input, { fetchImpl: (async () => okRes({ markdown: "", lessonIds: [] })) as unknown as typeof fetch, stateDir: dir, cfg })).toBe("");
    expect(await run(input, { fetchImpl: (async () => ({ ok: false })) as unknown as typeof fetch, stateDir: dir, cfg })).toBe("");
    expect(await run(input, { fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch, stateDir: dir, cfg })).toBe("");
    let called = false;
    expect(await run(input, { fetchImpl: (async () => { called = true; return okRes({}); }) as unknown as typeof fetch, stateDir: dir, cfg: { ...cfg, token: "" } })).toBe("");
    expect(called).toBe(false);
  });
});

/** 실제 프로세스로 — 가짜 서버 + stdin JSON. */
function spawnHook(stdin: string, env: Record<string, string>): Promise<{ code: number | null; out: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [join(__dirname, "teamspace-prompt-lessons.mjs")], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out, ms: Date.now() - t0 }));
    p.stdin.end(stdin);
  });
}

describe("teamspace-prompt-lessons — 프로세스", () => {
  it("가짜 서버에 POST 하고 additionalContext JSON 을 낸다", async () => {
    const seen: { token?: string; body?: Record<string, unknown> } = {};
    const srv = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        seen.token = String(req.headers["x-ws-token"]);
        seen.body = JSON.parse(b);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ markdown: "## 이 메시지와 관련된 팀 레슨\n- **x** `lx`", lessonIds: ["lx"], projectIds: ["bj"] }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    const dir = mkdtempSync(join(tmpdir(), "pl-"));
    try {
      const r = await spawnHook(JSON.stringify({ prompt: "반장 도면 작업 하자", session_id: "SP", cwd: dir, hook_event_name: "UserPromptSubmit" }), {
        WS_BASE: `http://127.0.0.1:${port}`,
        WS_TOKEN: "wst_test",
        TMPDIR: dir,
      });
      expect(r.code).toBe(0);
      const j = JSON.parse(r.out);
      expect(j.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
      expect(j.hookSpecificOutput.additionalContext).toContain("`lx`");
      expect(seen).toEqual({ token: "wst_test", body: { prompt: "반장 도면 작업 하자", cwd: dir, sessionId: "SP", exclude: [] } });
    } finally {
      srv.close();
    }
  });

  it("서버가 없으면 조용히 끝난다(출력 없음, 종료 0)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pl-"));
    const r = await spawnHook(JSON.stringify({ prompt: "반장 도면 작업 하자", session_id: "SQ", cwd: dir }), { WS_BASE: "http://127.0.0.1:9", WS_TOKEN: "wst_test", TMPDIR: dir });
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
  });

  it("짧은 메시지·깨진 stdin 은 네트워크 없이 끝난다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pl-"));
    expect((await spawnHook(JSON.stringify({ prompt: "ㅇㅇ", session_id: "S" }), { WS_BASE: "http://127.0.0.1:9", WS_TOKEN: "t", TMPDIR: dir })).out).toBe("");
    expect((await spawnHook("{not json", { WS_BASE: "http://127.0.0.1:9", WS_TOKEN: "t", TMPDIR: dir })).out).toBe("");
  });
});
