import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEARTBEAT_INTERVAL_MS, claimHeartbeat, extractPaths, heartbeatStateFile, pickProject, projectContextUrl, resolveRule } from "./teamspace-project-context.mjs";

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

  it("Bash command 문자열은 무시한다", () => {
    const got = extractPaths(
      { command: `cd ~/dev/banjang && cat "/Users/u/dev/banjang/a.ts" | grep -n foo src/x` },
      "/cwd",
      "/Users/u",
    );
    expect(got).toEqual([]);
  });

  it("루트 '/' 단독과 입력 없음은 무시한다", () => {
    expect(extractPaths({ command: "ls / && echo a/b" }, "/cwd")).toEqual([]);
    expect(extractPaths(undefined, "/cwd")).toEqual([]);
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
});
