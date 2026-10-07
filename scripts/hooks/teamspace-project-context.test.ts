import { describe, expect, it } from "vitest";
import { extractPaths, pickProject, resolveRule } from "./teamspace-project-context.mjs";

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

  it("Bash 명령에서 절대경로·~경로만 뽑는다", () => {
    const got = extractPaths(
      { command: `cd ~/dev/banjang && cat "/Users/u/dev/banjang/a.ts" | grep -n foo src/x` },
      "/cwd",
      "/Users/u",
    );
    expect(got).toEqual(["/Users/u/dev/banjang", "/Users/u/dev/banjang/a.ts"]);
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
