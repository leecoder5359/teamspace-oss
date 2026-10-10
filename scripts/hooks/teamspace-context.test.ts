import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { contextModeFor, contextUrl, gitInfo, ingestPayload, repoInfoFromRevParse } from "./teamspace-context.mjs";

// SessionStart 훅: 새 세션(startup·clear)엔 전체, 이어가기(resume·compact)엔 요약만 주입한다.
describe("contextModeFor", () => {
  it("startup 은 전체", () => expect(contextModeFor("startup")).toBe("full"));
  it("clear 는 전체", () => expect(contextModeFor("clear")).toBe("full"));
  it("source 가 없으면(구버전 Claude Code) 전체", () => expect(contextModeFor(undefined)).toBe("full"));
  it("resume 은 요약", () => expect(contextModeFor("resume")).toBe("brief"));
  it("compact 는 요약", () => expect(contextModeFor("compact")).toBe("brief"));
});

// 서버가 레슨 주입 기록에 어느 훅이 불렀는지 남기도록 via=SessionStart 를 붙인다.
describe("contextUrl", () => {
  it("새 세션: compact + via", () =>
    expect(contextUrl("http://h", "/a b", "full")).toBe("http://h/api/context?format=md&compact=1&via=SessionStart&cwd=%2Fa%20b"));
  it("이어가기: brief + via", () => expect(contextUrl("http://h", "/a", "brief")).toBe("http://h/api/context?format=md&compact=1&brief=1&via=SessionStart&cwd=%2Fa"));
});

// 라이브 세션 보드(Console 4): 세션 시작 인입에 레포·브랜치·워크트리를 싣는다.
describe("repoInfoFromRevParse", () => {
  it("본체 체크아웃: 워크트리 없음", () =>
    expect(repoInfoFromRevParse("develop\n/Users/u/dev/banjang\n/Users/u/dev/banjang/.git\n")).toEqual({ branch: "develop", repo: "banjang" }));
  it("연결된 워크트리: repo 는 본체 이름, worktree 는 그 경로", () =>
    expect(repoInfoFromRevParse("feat/x\n/Users/u/dev/teamspace/.claude/worktrees/agent-1\n/Users/u/dev/teamspace/.git\n")).toEqual({
      branch: "feat/x",
      repo: "teamspace",
      worktree: "/Users/u/dev/teamspace/.claude/worktrees/agent-1",
    }));
  it("분리된 HEAD 는 branch 없음", () => expect(repoInfoFromRevParse("HEAD\n/r/x\n/r/x/.git")).toEqual({ repo: "x" }));
  it("출력이 모자라면 빈 객체", () => expect(repoInfoFromRevParse("")).toEqual({}));
});

describe("gitInfo · ingestPayload", () => {
  it("저장소가 아니면 빈 객체(실패 무해)", () => expect(gitInfo(tmpdir())).toEqual({}));
  it("이 레포에서는 repo 가 나온다", () => expect(typeof gitInfo(process.cwd()).repo).toBe("string"));
  it("저장소 정보는 있을 때만 붙는다", () => {
    expect(ingestPayload("s1", "/c")).toEqual({ sessionId: "s1", cwd: "/c", status: "active" });
    expect(ingestPayload("s1", "/c", { branch: "main", repo: "r" })).toEqual({ sessionId: "s1", cwd: "/c", status: "active", branch: "main", repo: "r" });
  });
});
