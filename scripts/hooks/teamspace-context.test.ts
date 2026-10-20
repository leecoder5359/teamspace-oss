import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contextModeFor, contextUrl, extractLessonIds, gitInfo, ingestPayload, promptStateFile, repoInfoFromRevParse, seedPromptState } from "./teamspace-context.mjs";
import { promptStateFile as promptHookStateFile, readState } from "./teamspace-prompt-lessons.mjs";

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

// L4: 세션 시작에 넣은 레슨 id 를 UserPromptSubmit 상태 파일에 미리 적어, 메시지마다 같은 레슨이 다시 실리지 않게 한다.
describe("extractLessonIds", () => {
  const A = "cmaaaaaaaaaaaaaaaaaaaaaaa1";
  const B = "cmbbbbbbbbbbbbbbbbbbbbbbb2";
  const md = [
    "# 워크스페이스: 팀",
    "",
    "## 팀 작업규칙·레슨 — 반드시 따른다 (필수 2 · 전역 0)",
    "### 필수 (2)",
    `- **규칙 A** — 요약 \`${A}\``,
    `- **규칙 B** \`${B}\``,
    "- … 외 3개 (전체 제목: MCP `lesson_list`)",
    `_전문은 MCP \`lesson_get {id}\` \`cmzzzzzzzzzzzzzzzzzzzzzzz9\`_`,
    "",
    "## 지식 지도 — 허브 1 · 군집 0",
    `- **허브 문서** \`cmdddddddddddddddddddddddd\``,
  ].join("\n");
  it("레슨 섹션의 요약(gist) 줄 id 만 — 제목만 줄(B)은 규칙을 전하지 않으므로 넣지 않는다", () => expect(extractLessonIds(md)).toEqual([A]));
  it("요약 줄 여러 개는 중복 없이 순서대로", () => {
    const two = `## 팀 작업규칙·레슨\n- **a** — 요약 \`${A}\`\n- **b** — 요약 \`${B}\`\n- **a** — 다시 \`${A}\``;
    expect(extractLessonIds(two)).toEqual([A, B]);
  });
  it("짧은 id·대문자·다른 섹션은 무시", () => {
    expect(extractLessonIds("## 팀 작업규칙·레슨\n- **x** — 요약 `cshort`\n- **y** — 요약 `cmAAAAAAAAAAAAAAAAAAAAAAA`")).toEqual([]);
    expect(extractLessonIds("## 결정\n- **x** — 요약 `cmaaaaaaaaaaaaaaaaaaaaaaa1`")).toEqual([]);
  });
  it("레슨 섹션이 없거나 입력이 문자열이 아니면 빈 배열", () => {
    expect(extractLessonIds("# 제목만")).toEqual([]);
    expect(extractLessonIds(undefined)).toEqual([]);
  });
});

describe("seedPromptState", () => {
  it("상태 파일 경로는 UserPromptSubmit 훅과 같다(메인 세션)", () => {
    expect(promptStateFile("s/1", undefined, "/d")).toBe(promptHookStateFile("s/1", undefined, "/d"));
  });
  it("기존 injected 와 합친다(중복 없이) — prompt 훅이 그대로 읽는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-"));
    const f = promptStateFile("s1", undefined, dir);
    writeFileSync(f, JSON.stringify({ injected: ["old", "a"] }));
    seedPromptState("s1", ["a", "b"], dir);
    expect(readState(f).injected).toEqual(["old", "a", "b"]);
  });
  it("파일이 없으면 새로 만든다, id 가 없으면 쓰지 않는다", () => {
    const dir = mkdtempSync(join(tmpdir(), "seed-"));
    seedPromptState("s2", [], dir);
    expect(() => readFileSync(promptStateFile("s2", undefined, dir))).toThrow();
    seedPromptState("s2", ["x"], dir);
    expect(readState(promptStateFile("s2", undefined, dir)).injected).toEqual(["x"]);
  });
  it("쓰기 실패는 무해(throw 하지 않는다)", () => {
    expect(() => seedPromptState("s3", ["x"], join(tmpdir(), "no-such-dir-xyz", "deeper"))).not.toThrow();
  });
});
