import { describe, expect, it } from "vitest";
import { draftFromCommits, gitRangeArg, isAutoDraftEntry, nextVersion, parseGitLog, pickAnchor, pickAnchorSource } from "./changelogDraft";

describe("parseGitLog", () => {
  it("탭 구분·한글 제목을 읽는다", () => {
    const r = parseGitLog("abc1234\t2026-10-09\tfeat(env): 한글 제목\ndef5678\t2026-10-08\tfix: a\tb 탭 포함\n");
    expect(r).toEqual([
      { hash: "abc1234", date: "2026-10-09", subject: "feat(env): 한글 제목" },
      { hash: "def5678", date: "2026-10-08", subject: "fix: a\tb 탭 포함" },
    ]);
  });
  it("빈 입력·깨진 줄은 무시", () => {
    expect(parseGitLog("")).toEqual([]);
    expect(parseGitLog("\n  \nno-tabs-here\n")).toEqual([]);
  });
});

describe("draftFromCommits", () => {
  const c = (subject: string) => ({ hash: "h", date: "2026-10-09", subject });
  const opts = { today: "2026-10-09" };
  it("feat/fix/perf 만 포함", () => {
    const d = draftFromCommits([c("feat(a): 하나"), c("chore: 무시"), c("docs(x): 무시"), c("perf(b): 둘"), c("fix(a): 셋")], opts);
    expect(d?.body).toBe("기간: 2026-10-09 ~ 2026-10-09\n\n- a: 하나\n- a: 셋\n- b: 둘");
  });
  it("scope 없는 커밋은 맨 뒤 불릿", () => {
    const d = draftFromCommits([c("fix: 단독"), c("feat(env): 값")], opts);
    expect(d?.body).toBe("기간: 2026-10-09 ~ 2026-10-09\n\n- env: 값\n- 단독");
    expect(d?.title).toBe("배포 2026-10-09");
    expect(d?.version).toBe("2026.10.09");
  });
  it("같은 날 기존 버전이 있으면 증분", () => {
    expect(draftFromCommits([c("fix: x")], { ...opts, existingVersions: ["2026.10.09"] })?.version).toBe("2026.10.09.2");
  });
  it("해당 커밋이 없으면 null", () => {
    expect(draftFromCommits([c("chore: x")], opts)).toBeNull();
    expect(draftFromCommits([], opts)).toBeNull();
  });
});

describe("draftFromCommits — 기간·상한", () => {
  it("기간 첫 줄: since 날짜·ISO 시각은 날짜만, ref 는 그대로, 없으면 가장 이른 커밋", () => {
    const cs = [{ hash: "h", date: "2026-10-07", subject: "fix: a" }, { hash: "h", date: "2026-10-05", subject: "feat: b" }];
    const first = (since?: string) => draftFromCommits(cs, { today: "2026-10-09", since })?.body.split("\n")[0];
    expect(first("2026-10-01T03:04:05.000Z")).toBe("기간: 2026-10-01 ~ 2026-10-09");
    expect(first("v1.2")).toBe("기간: v1.2 ~ 2026-10-09");
    expect(first()).toBe("기간: 2026-10-05 ~ 2026-10-09");
  });
  it("불릿 50개 상한 + … 외 N건", () => {
    const cs = Array.from({ length: 172 }, (_, i) => ({ hash: "h", date: "2026-10-09", subject: `fix: n${i}` }));
    const lines = draftFromCommits(cs, { today: "2026-10-09" })!.body.split("\n");
    expect(lines.filter((l) => l.startsWith("- "))).toHaveLength(50);
    expect(lines.at(-1)).toBe("… 외 122건");
    expect(lines.at(-2)).toBe("- n49");
  });
  it("정확히 50개면 꼬리 없음", () => {
    const cs = Array.from({ length: 50 }, (_, i) => ({ hash: "h", date: "2026-10-09", subject: `fix: n${i}` }));
    expect(draftFromCommits(cs, { today: "2026-10-09" })!.body).not.toContain("외");
  });
});

describe("pickAnchor", () => {
  it("자동 초안 항목(YYYY.MM.DD(.N) + 배포 제목)만 앵커로 쓴다", () => {
    const entries = [
      { version: "1.4.0", title: "로요 릴리스", releasedAt: "2026-10-08T00:00:00.000Z" },
      { version: "2026.10.01", title: "배포 2026-10-01", releasedAt: "2026-10-01T10:00:00.000Z" },
      { version: "2026.10.03.2", title: "배포 2026-10-03", releasedAt: "2026-10-03T10:00:00.000Z" },
      { version: "2026.10.05", title: "수동 메모", releasedAt: "2026-10-05T10:00:00.000Z" },
    ];
    expect(pickAnchor(entries)).toBe("2026-10-03T10:00:00.000Z");
  });
  it("자동 초안이 없으면 undefined", () => {
    expect(pickAnchor([{ version: "1.0", title: "배포", releasedAt: "2026-07-20" }])).toBeUndefined();
    expect(pickAnchor([])).toBeUndefined();
  });
  it("isAutoDraftEntry", () => {
    expect(isAutoDraftEntry({ version: "2026.10.09", title: "배포 2026-10-09" })).toBe(true);
    expect(isAutoDraftEntry({ version: "2026.10.09.x", title: "배포" })).toBe(false);
    expect(isAutoDraftEntry({ version: null, title: "배포" })).toBe(false);
  });
});

describe("gitRangeArg", () => {
  it("날짜·ISO 시각은 --since=, ref 는 ..HEAD", () => {
    expect(gitRangeArg("2026-10-01")).toBe("--since=2026-10-01");
    expect(gitRangeArg("2026-10-01T03:04:05.000Z")).toBe("--since=2026-10-01T03:04:05.000Z");
    expect(gitRangeArg("v2026-10-01")).toBe("v2026-10-01..HEAD");
  });
  it("- 로 시작하거나 빈 값은 거부", () => {
    expect(() => gitRangeArg("--output=/tmp/x")).toThrow();
    expect(() => gitRangeArg("")).toThrow();
  });
});

describe("nextVersion", () => {
  it("없으면 날짜 그대로", () => expect(nextVersion([], "2026-10-09")).toBe("2026.10.09"));
  it("있으면 .2", () => expect(nextVersion(["2026.10.09"], "2026-10-09")).toBe("2026.10.09.2"));
  it(".2 까지 있으면 .3", () => expect(nextVersion(["2026.10.09", "2026.10.09.2"], "2026-10-09")).toBe("2026.10.09.3"));
});

describe("pickAnchorSource", () => {
  const auto = (d: string) => ({ version: "2026.10.09", title: "배포 2026-10-09", releasedAt: d });
  it("프로젝트 항목이 있으면 그쪽 앵커만 쓰고 공용은 무시", () => {
    const r = pickAnchorSource([auto("2026-10-05T00:00:00Z")], [auto("2026-10-09T00:00:00Z")]);
    expect(r).toMatchObject({ source: "project", anchor: "2026-10-05T00:00:00Z" });
  });
  it("프로젝트 항목 0건이면 공용 앵커로 폴백, 버전은 공용 것을 센다", () => {
    const r = pickAnchorSource([], [auto("2026-10-09T00:00:00Z")]);
    expect(r).toMatchObject({ source: "shared", anchor: "2026-10-09T00:00:00Z", existingVersions: ["2026.10.09"] });
  });
  it("둘 다 앵커 없으면 default(7일)", () => {
    expect(pickAnchorSource([], []).source).toBe("default");
    expect(pickAnchorSource([{ version: "v1", title: "수동", releasedAt: "2026-10-01" }], [auto("2026-10-09")]).source).toBe("default");
  });
});
