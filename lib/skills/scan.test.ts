import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  branchFromHead,
  classifyLocation,
  displayPath,
  mainRepoFromGitDir,
  parseFrontmatter,
  parseGitDirPointer,
  scanSkills,
  skillScanConfig,
  type GitCtx,
} from "./scan";

describe("skillScanConfig", () => {
  it("비어 있으면 null(기능 숨김)", () => {
    expect(skillScanConfig({}, "/h")).toBeNull();
    expect(skillScanConfig({ SKILL_SCAN_ROOTS: " : " }, "/h")).toBeNull();
  });
  it("콜론 구분·~ 펼침·상대 경로 버림·중복 제거·깊이 기본 7", () => {
    const c = skillScanConfig({ SKILL_SCAN_ROOTS: "~/dev:~/.claude:rel/x:~/dev" }, "/h")!;
    expect(c.roots).toEqual(["/h/dev", "/h/.claude"]);
    expect(c.maxDepth).toBe(7);
  });
  it("깊이는 1~12 로 자른다", () => {
    expect(skillScanConfig({ SKILL_SCAN_ROOTS: "/a", SKILL_SCAN_MAX_DEPTH: "99" }, "/h")!.maxDepth).toBe(12);
    expect(skillScanConfig({ SKILL_SCAN_ROOTS: "/a", SKILL_SCAN_MAX_DEPTH: "0" }, "/h")!.maxDepth).toBe(7);
    expect(skillScanConfig({ SKILL_SCAN_ROOTS: "/a", SKILL_SCAN_MAX_DEPTH: "3" }, "/h")!.maxDepth).toBe(3);
  });
  it("시간 한도는 env(기본 15초, 0.5~120초로 자름)", () => {
    expect(skillScanConfig({ SKILL_SCAN_ROOTS: "/a" }, "/h")!.timeBudgetMs).toBe(15_000);
    expect(skillScanConfig({ SKILL_SCAN_ROOTS: "/a", SKILL_SCAN_TIME_BUDGET_MS: "3000" }, "/h")!.timeBudgetMs).toBe(3000);
    expect(skillScanConfig({ SKILL_SCAN_ROOTS: "/a", SKILL_SCAN_TIME_BUDGET_MS: "10" }, "/h")!.timeBudgetMs).toBe(500);
    expect(skillScanConfig({ SKILL_SCAN_ROOTS: "/a", SKILL_SCAN_TIME_BUDGET_MS: "9999999" }, "/h")!.timeBudgetMs).toBe(120_000);
    expect(skillScanConfig({ SKILL_SCAN_ROOTS: "/a", SKILL_SCAN_TIME_BUDGET_MS: "abc" }, "/h")!.timeBudgetMs).toBe(15_000);
  });
});

describe("parseFrontmatter", () => {
  it("name·description(따옴표 제거)", () => {
    expect(parseFrontmatter('---\nname: teamspace\ndescription: "TeamSpace API 관리"\n---\n# 본문')).toEqual({ name: "teamspace", description: "TeamSpace API 관리" });
  });
  it("블록 스칼라 description 은 첫 줄", () => {
    expect(parseFrontmatter("---\nname: x\ndescription: >\n  첫 줄\n  둘째 줄\n---\n").description).toBe("첫 줄");
  });
  it("앞머리 없으면 null", () => {
    expect(parseFrontmatter("# 제목\n본문")).toEqual({ name: null, description: null });
    expect(parseFrontmatter("---\nname: x\n")).toEqual({ name: null, description: null });
  });
  it("CRLF·BOM 허용", () => {
    expect(parseFrontmatter("﻿---\r\nname: y\r\n---\r\n").name).toBe("y");
  });
});

describe("git 파일 파싱", () => {
  it("gitdir 포인터(절대·상대)", () => {
    expect(parseGitDirPointer("gitdir: /r/main/.git/worktrees/wt1\n", "/r/wt1")).toBe("/r/main/.git/worktrees/wt1");
    expect(parseGitDirPointer("gitdir: ../main/.git/worktrees/wt1", "/r/wt1")).toBe("/r/main/.git/worktrees/wt1");
    expect(parseGitDirPointer("nothing", "/r")).toBeNull();
  });
  it("워크트리 gitdir → 메인 레포, 서브모듈은 null", () => {
    expect(mainRepoFromGitDir("/r/banjang/.git/worktrees/banjang-wt-a")).toBe("/r/banjang");
    expect(mainRepoFromGitDir("/r/x/.git/modules/sub")).toBeNull();
  });
  it("HEAD → 브랜치/분리", () => {
    expect(branchFromHead("ref: refs/heads/feature/a-b\n")).toBe("feature/a-b");
    expect(branchFromHead("0123456789abcdef0123456789abcdef01234567")).toBe("(detached 0123456)");
    expect(branchFromHead("garbage")).toBeNull();
  });
});

describe("classifyLocation", () => {
  const git: GitCtx = { kind: "worktree", checkout: "/h/dev/b-wt", mainRepo: "/h/dev/b", repo: "b", branch: "x" };
  it("플러그인은 git 보다 먼저(마켓플레이스 범위)", () => {
    expect(classifyLocation("/h/.claude/plugins/cache/mk/p/1.0/skills/s/SKILL.md", git, "/h")).toEqual({ kind: "plugin", scope: "plugin:mk/p" });
    expect(classifyLocation("/h/.claude/plugins/marketplaces/mk2/skills/s/SKILL.md", null, "/h")).toEqual({ kind: "plugin", scope: "plugin:mk2" });
  });
  it("플러그인 범위: 버전·plugins 접두·끝 skills 는 빼고, 변형은 가른다", () => {
    const sc = (p: string) => classifyLocation(`/h/.claude/plugins/${p}/SKILL.md`, null, "/h").scope;
    expect(sc("cache/official/figma/2.2.120/skills/figma-use")).toBe("plugin:official/figma");
    expect(sc("cache/official/figma/2.2.127/skills/figma-use")).toBe("plugin:official/figma");
    expect(sc("marketplaces/official/plugins/figma/skills/figma-use")).toBe("plugin:official/figma");
    expect(sc("cache/official/figma/2.2.127/skills-figquery/figma-use")).toBe("plugin:official/figma/skills-figquery");
    expect(sc("marketplaces/official/external_plugins/discord/skills/access")).toBe("plugin:official/discord");
    expect(sc("marketplaces/official/external_plugins/telegram/skills/access")).toBe("plugin:official/telegram");
    expect(sc("cache/lvl/superpowers/abc1234def/skills/brainstorming")).toBe("plugin:lvl/superpowers");
  });
  it("전역·레포·기타", () => {
    expect(classifyLocation("/h/.claude/skills/s/SKILL.md", null, "/h")).toEqual({ kind: "global", scope: "global" });
    expect(classifyLocation("/h/dev/b-wt/.claude/skills/s/SKILL.md", git, "/h")).toEqual({ kind: "worktree", scope: "repo:b" });
    expect(classifyLocation("/h/misc/s/SKILL.md", null, "/h")).toEqual({ kind: "other", scope: "other" });
  });
  it("displayPath 는 홈을 ~ 로", () => {
    expect(displayPath("/h/dev/x", "/h")).toBe("~/dev/x");
    expect(displayPath("/hx/dev", "/h")).toBe("/hx/dev");
  });
});

/* ── 임시 폴더 픽스처: 메인 레포 + 연결 워크트리 + 전역 + 플러그인 + 제외 폴더 + 심볼릭 링크 ── */
describe("scanSkills (fixture)", () => {
  let home: string;
  const skill = (dir: string, body: string, mtime?: Date) => {
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "SKILL.md");
    writeFileSync(f, body);
    if (mtime) utimesSync(f, mtime, mtime);
  };

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "skreg-"));
    const dev = join(home, "dev");
    // 메인 레포 banjang (.git 폴더, HEAD=develop)
    mkdirSync(join(dev, "banjang", ".git", "worktrees", "banjang-wt-a"), { recursive: true });
    writeFileSync(join(dev, "banjang", ".git", "HEAD"), "ref: refs/heads/develop\n");
    writeFileSync(join(dev, "banjang", ".git", "worktrees", "banjang-wt-a", "HEAD"), "ref: refs/heads/feature/a\n");
    skill(join(dev, "banjang", ".claude", "skills", "deploy"), "---\nname: deploy\ndescription: 배포\n---\nv2\n", new Date("2026-10-08T00:00:00Z"));
    // 연결 워크트리 (.git 파일)
    mkdirSync(join(dev, "banjang-wt-a"), { recursive: true });
    writeFileSync(join(dev, "banjang-wt-a", ".git"), `gitdir: ${join(dev, "banjang", ".git", "worktrees", "banjang-wt-a")}\n`);
    skill(join(dev, "banjang-wt-a", ".claude", "skills", "deploy"), "---\nname: deploy\n---\nv1\n", new Date("2026-10-01T00:00:00Z"));
    // 앞머리 없는 스킬 → 폴더 이름
    skill(join(dev, "banjang", ".claude", "skills", "no-fm"), "# 그냥 본문\n");
    // 제외 폴더
    skill(join(dev, "banjang", "node_modules", "pkg", "skills", "x"), "---\nname: ignored\n---\n");
    skill(join(dev, "banjang", "app", "generated", "x"), "---\nname: ignored2\n---\n");
    // 심볼릭 링크는 따라가지 않는다
    symlinkSync(join(dev, "banjang", ".claude"), join(dev, "linked"));
    // 전역·플러그인
    skill(join(home, ".claude", "skills", "g1"), "---\nname: g1\n---\n");
    skill(join(home, ".claude", "plugins", "cache", "mk", "p", "1.0", "skills", "s"), "---\nname: s\n---\nold\n");
    // 너무 깊음 (depth 제한 3 이면 제외)
    skill(join(dev, "a", "b", "c", "d", "e"), "---\nname: deep\n---\n");
    // 레포 안 소스 트리는 내려가지 않는다(.claude·.agents 만)
    skill(join(dev, "banjang", "packages", "x", "skills", "y"), "---\nname: in-src\n---\n");
    skill(join(dev, "banjang", ".agents", "skills", "ag"), "---\nname: ag\n---\n");
    // skills/ 바로 아래는 제외 이름(build)이어도 스킬 폴더
    skill(join(dev, "banjang", ".claude", "skills", "build"), "---\nname: build\n---\n");
    // 레포 안 워크트리(.claude/worktrees/<이름>) — 다시 .claude 만
    mkdirSync(join(dev, "banjang", ".git", "worktrees", "wt-in"), { recursive: true });
    writeFileSync(join(dev, "banjang", ".git", "worktrees", "wt-in", "HEAD"), "ref: refs/heads/feature/in\n");
    mkdirSync(join(dev, "banjang", ".claude", "worktrees", "wt-in"), { recursive: true });
    writeFileSync(join(dev, "banjang", ".claude", "worktrees", "wt-in", ".git"), `gitdir: ${join(dev, "banjang", ".git", "worktrees", "wt-in")}\n`);
    skill(join(dev, "banjang", ".claude", "worktrees", "wt-in", ".claude", "skills", "deploy"), "---\nname: deploy\n---\nv1\n");
    skill(join(dev, "banjang", ".claude", "worktrees", "wt-in", "src", "skills", "z"), "---\nname: wt-src\n---\n");
    // 플러그인 원본 레포(.claude-plugin)는 통째로
    mkdirSync(join(dev, "plug", ".git"), { recursive: true });
    writeFileSync(join(dev, "plug", ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(dev, "plug", ".claude-plugin"), { recursive: true });
    skill(join(dev, "plug", "plug", "skills", "ps"), "---\nname: ps\n---\n");
    // ~/.claude 의 세션 기록 폴더는 건너뛴다
    skill(join(home, ".claude", "projects", "p", "x"), "---\nname: in-projects\n---\n");
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("레포·워크트리·전역·플러그인을 구분하고 제외·링크를 건너뛴다", async () => {
    const r = await scanSkills({ roots: [join(home, "dev"), join(home, ".claude")], maxDepth: 7, home });
    const names = r.copies.map((c) => c.name).sort();
    expect(names).toEqual(["ag", "build", "deep", "deploy", "deploy", "deploy", "g1", "no-fm", "ps", "s"]);
    expect(r.copies.find((c) => c.path.includes("wt-in"))).toMatchObject({ kind: "worktree", repo: "banjang", branch: "feature/in" });
    expect(r.copies.find((c) => c.name === "ps")).toMatchObject({ kind: "repo", repo: "plug" });
    const main = r.copies.find((c) => c.name === "deploy" && c.kind === "repo")!;
    expect(main).toMatchObject({ repo: "banjang", branch: "develop", description: "배포", lines: 5, scope: "repo:banjang" });
    const wt = r.copies.find((c) => c.name === "deploy" && c.kind === "worktree")!;
    expect(wt).toMatchObject({ repo: "banjang", branch: "feature/a", scope: "repo:banjang" });
    expect(wt.sha256).not.toBe(main.sha256);
    expect(wt.id).toMatch(/^[0-9a-f]{12}$/);
    expect(r.copies.find((c) => c.name === "g1")!.kind).toBe("global");
    expect(r.copies.find((c) => c.name === "s")!.scope).toBe("plugin:mk/p");
    expect(r.copies.find((c) => c.name === "deep")!.kind).toBe("other");
    expect(r.truncated).toBe(false);
  });

  it("깊이 제한", async () => {
    const r = await scanSkills({ roots: [join(home, "dev")], maxDepth: 3, home });
    expect(r.copies.some((c) => c.name === "deep")).toBe(false);
  });

  it("루트가 레포 안쪽이어도 조상의 git 문맥을 쓴다", async () => {
    const r = await scanSkills({ roots: [join(home, "dev", "banjang-wt-a", ".claude")], maxDepth: 7, home });
    expect(r.copies[0]).toMatchObject({ kind: "worktree", repo: "banjang", branch: "feature/a" });
  });

  it("한도에 닿으면 truncated", async () => {
    const r = await scanSkills({ roots: [join(home, "dev"), join(home, ".claude")], maxDepth: 7, home }, { maxCopies: 2 });
    expect(r.truncated).toBe(true);
    expect(r.truncatedReason).toBe("max_copies");
    expect(r.copies.length).toBe(2);
  });

  it("없는 루트는 exists:false", async () => {
    const r = await scanSkills({ roots: [join(home, "nope")], maxDepth: 7, home });
    expect(r.roots).toEqual([{ path: join(home, "nope"), exists: false }]);
    expect(r.copies).toEqual([]);
  });
});
