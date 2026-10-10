import { describe, expect, it } from "vitest";
import {
  CACHE_TTL_MS,
  TRUNCATED_CACHE_TTL_MS,
  _resetRegistryCache,
  cacheTtlFor,
  filterGroups,
  getRegistry,
  groupCopies,
  pickCanonical,
  unifiedDiff,
} from "./registry";
import type { ScanResult, SkillCopy } from "./scan";

const H = "/h";
let seq = 0;
const copy = (o: Partial<SkillCopy> & { path: string }): SkillCopy => ({
  id: `id${seq++}`,
  name: "writing-plans",
  description: null,
  sha256: "A",
  lines: 10,
  bytes: 100,
  mtime: "2026-10-01T00:00:00.000Z",
  kind: "repo",
  scope: "repo:banjang",
  repo: "banjang",
  branch: "develop",
  checkout: "/h/dev/banjang",
  root: "/h/dev",
  ...o,
});

describe("pickCanonical", () => {
  it("메인 체크아웃 사본, 여럿이면 .claude/skills 우선", () => {
    const a = copy({ path: "/h/dev/banjang/.agents/skills/w/SKILL.md", mtime: "2026-10-09T00:00:00Z" });
    const b = copy({ path: "/h/dev/banjang/.claude/skills/w/SKILL.md" });
    const w = copy({ path: "/h/dev/wt/.claude/skills/w/SKILL.md", kind: "worktree", mtime: "2026-10-10T00:00:00Z" });
    expect(pickCanonical([a, w, b]).id).toBe(b.id);
  });
  it("메인 사본이 없으면 가장 최근", () => {
    const x = copy({ path: "/h/.claude/plugins/cache/m/p/1/skills/s/SKILL.md", kind: "plugin", mtime: "2026-09-01T00:00:00Z" });
    const y = copy({ path: "/h/.claude/plugins/cache/m/p/2/skills/s/SKILL.md", kind: "plugin", mtime: "2026-10-01T00:00:00Z" });
    expect(pickCanonical([x, y]).id).toBe(y.id);
  });
});

describe("groupCopies", () => {
  const main = copy({ path: "/h/dev/banjang/.claude/skills/w/SKILL.md", sha256: "NEW", mtime: "2026-10-05T00:00:00Z" });
  const same = copy({ path: "/h/dev/b-wt1/.claude/skills/w/SKILL.md", kind: "worktree", sha256: "NEW", branch: "f1", mtime: "2026-10-01T00:00:00Z" });
  const stale = copy({ path: "/h/dev/b-wt2/.claude/skills/w/SKILL.md", kind: "worktree", sha256: "OLD", branch: "f2", mtime: "2026-09-01T00:00:00Z" });
  const newer = copy({ path: "/h/dev/b-wt3/.claude/skills/w/SKILL.md", kind: "worktree", sha256: "WIP", branch: "f3", mtime: "2026-10-08T00:00:00Z" });
  // 다른 레포의 같은 이름 스킬은 다른 묶음
  const other = copy({ path: "/h/dev/teamspace/.claude/skills/w/SKILL.md", scope: "repo:teamspace", repo: "teamspace", sha256: "TS" });
  const g = copy({ path: "/h/.claude/skills/z/SKILL.md", name: "z", kind: "global", scope: "global", repo: null, branch: null, checkout: null });

  const { groups, summary } = groupCopies([main, same, stale, newer, other, g], H);

  it("이름+범위로 묶고 상태를 매긴다", () => {
    expect(groups.map((x) => x.key)).toEqual(["writing-plans@repo:banjang", "writing-plans@repo:teamspace", "z@global"]);
    const b = groups[0];
    expect(b.canonicalId).toBe(main.id);
    expect(Object.fromEntries(b.copies.map((c) => [c.branch, c.status]))).toEqual({ develop: "canonical", f1: "same", f2: "stale", f3: "differs_newer" });
    expect(b.copies.map((c) => c.status)).toEqual(["canonical", "stale", "differs_newer", "same"]);
    expect(b).toMatchObject({ distinct: 3, stale: 1, differs: 2 });
  });
  it("경로는 ~ 로 줄여 내보낸다", () => {
    expect(groups[0].copies[0].path).toBe("~/dev/banjang/.claude/skills/w/SKILL.md");
    expect(groups[0].copies[0].checkout).toBe("~/dev/banjang");
  });
  it("요약", () => {
    expect(summary).toEqual({ groups: 3, copies: 6, staleCopies: 1, groupsWithStale: 1, differingCopies: 2, distinctContents: 5 });
  });
  it("필터: 낡은 것만·이름", () => {
    expect(filterGroups(groups, { stale: true }).map((x) => x.key)).toEqual(["writing-plans@repo:banjang"]);
    expect(filterGroups(groups, { name: "Z" }).map((x) => x.key)).toEqual(["z@global"]);
    expect(filterGroups(groups, {}).length).toBe(3);
  });
});

describe("unifiedDiff", () => {
  it("같으면 identical", () => {
    expect(unifiedDiff("a\nb\n", "a\nb")).toMatchObject({ identical: true, lines: [] });
  });
  it("문맥 3줄 훅과 줄 번호", () => {
    const a = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].join("\n");
    const b = ["1", "2", "3", "4", "five", "6", "7", "8", "9", "10", "11"].join("\n");
    const d = unifiedDiff(a, b, { aLabel: "A", bLabel: "B" });
    expect(d).toMatchObject({ added: 2, removed: 1, truncated: false, identical: false });
    expect(d.lines).toEqual([
      "--- A",
      "+++ B",
      "@@ -2,9 +2,10 @@",
      " 2",
      " 3",
      " 4",
      "-5",
      "+five",
      " 6",
      " 7",
      " 8",
      " 9",
      " 10",
      "+11",
    ]);
  });
  it("멀리 떨어진 변경은 훅이 나뉜다", () => {
    const a = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const b = [...a];
    b[1] = "X";
    b[25] = "Y";
    const d = unifiedDiff(a.join("\n"), b.join("\n"));
    expect(d.lines.filter((l) => l.startsWith("@@"))).toEqual(["@@ -1,5 +1,5 @@", "@@ -23,7 +23,7 @@"]);
  });
  it("빈 파일에서 추가", () => {
    expect(unifiedDiff("", "x\ny").lines).toEqual(["--- a", "+++ b", "@@ -0,0 +1,2 @@", "+x", "+y"]);
  });
  it("최대 줄 수로 자른다", () => {
    const b = Array.from({ length: 50 }, (_, i) => `n${i}`).join("\n");
    const d = unifiedDiff("", b, { maxLines: 10 });
    expect(d.truncated).toBe(true);
    expect(d.lines.length).toBe(10);
    expect(d.added).toBe(50);
  });
});

describe("캐시 수명", () => {
  it("정상 5분, 잘린 결과 30초, 잘린 0개는 캐시 안 함", () => {
    expect(cacheTtlFor({ truncated: false, copies: 0 })).toBe(CACHE_TTL_MS);
    expect(cacheTtlFor({ truncated: true, copies: 3 })).toBe(TRUNCATED_CACHE_TTL_MS);
    expect(cacheTtlFor({ truncated: true, copies: 0 })).toBe(0);
  });

  it("잘린 0개 결과는 다음 요청이 다시 훑는다", async () => {
    _resetRegistryCache();
    const env = { SKILL_SCAN_ROOTS: "/nowhere-skreg" };
    let calls = 0;
    const res = (truncated: boolean): ScanResult => ({
      copies: truncated ? [] : [copy({ path: "/h/dev/banjang/.claude/skills/w/SKILL.md" })],
      truncated,
      truncatedReason: truncated ? "time_budget" : null,
      dirsVisited: 1,
      errors: 0,
      durationMs: 1,
      roots: [],
      maxDepth: 7,
    });
    const scanner = async () => res(++calls === 1);
    const a = await getRegistry({ env, scanner });
    expect(a).toMatchObject({ summary: { copies: 0 }, scan: { truncated: true } });
    const b = await getRegistry({ env, scanner });
    expect(calls).toBe(2);
    expect(b).toMatchObject({ summary: { copies: 1 } });
    await getRegistry({ env, scanner });
    expect(calls).toBe(2); // 정상 결과는 캐시
    _resetRegistryCache();
  });
});
