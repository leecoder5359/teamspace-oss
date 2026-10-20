import { describe, it, expect } from "vitest";
import { linkChecks, titleTokens, jaccard, similarTitlePairs, injectionStats, type InjectionRow } from "./analyze";
import { normalizeVia, injectionIds, briefInjectionIds } from "./log";
import { renderBrief } from "@/lib/contextBrief";

const rule = (id: string, cwdPrefix: string, projectId: string | null, priority = 0) => ({ id, cwdPrefix, projectId, priority, workspaceId: "ws" });

describe("linkChecks", () => {
  const projects = [
    { id: "ts", name: "TeamSpace", stack: ["next"] },
    { id: "bj", name: "반장", stack: [] },
    { id: "lo", name: "로요", stack: [] },
  ];
  const lessons = [
    { id: "g", title: "전역", projectId: null, stack: null },
    { id: "n", title: "next 규칙", projectId: null, stack: "next" },
    { id: "s", title: "supabase 규칙", projectId: null, stack: "supabase" },
  ];
  const rules = [rule("r1", "/dev/teamspace", "ts"), rule("r2", "/dev/banjang", "bj"), rule("r3", "/dev/gone", "deleted"), rule("r4", "/dev/ws-only", null)];

  it("최근 cwd 중 프로젝트로 해석되지 않는 것(규칙 없음·프로젝트 없는 규칙·없는 프로젝트)을 잡는다", () => {
    const now = new Date("2026-10-08T00:00:00Z");
    const r = linkChecks({
      rules,
      projects,
      lessons,
      recentCwds: [
        { cwd: "/dev/teamspace/app", count: 5, lastAt: now },
        { cwd: "/dev/other", count: 3, lastAt: now },
        { cwd: "/dev/gone/x", count: 1, lastAt: now },
        { cwd: "/dev/ws-only", count: 2, lastAt: now },
      ],
    });
    expect(r.unmappedCwds.map((c) => c.cwd)).toEqual(["/dev/other", "/dev/ws-only", "/dev/gone/x"]);
  });

  it("stack 빈 프로젝트(매핑된 것 먼저)와 놓치는 스택 레슨 수", () => {
    const r = linkChecks({ rules, projects, lessons, recentCwds: [] });
    expect(r.emptyStackProjects).toEqual([
      { id: "bj", name: "반장", mapped: true, missedStackLessons: 2 },
      { id: "lo", name: "로요", mapped: false, missedStackLessons: 2 },
    ]);
  });

  it("어느 프로젝트에도 안 맞는 스택 레슨, 없는 프로젝트를 가리키는 규칙", () => {
    const r = linkChecks({ rules, projects, lessons, recentCwds: [] });
    expect(r.orphanStackLessons.map((l) => l.id)).toEqual(["s"]);
    expect(r.brokenRouteRules).toEqual([{ id: "r3", cwdPrefix: "/dev/gone", projectId: "deleted" }]);
  });
});

describe("제목 유사도", () => {
  it("공백·문장부호로 자르고 소문자로", () => {
    expect([...titleTokens("Slack 컨펌, 자동 폴링!")]).toEqual(["slack", "컨펌", "자동", "폴링"]);
  });
  it("자카드", () => {
    expect(jaccard(titleTokens("a b c"), titleTokens("a b d"))).toBeCloseTo(0.5);
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
  it("0.6 이상 쌍만, 점수 내림차순", () => {
    const pairs = similarTitlePairs([
      { id: "1", title: "공유 브랜치 푸시 조율" },
      { id: "2", title: "공유 브랜치 푸시 조율 규칙" },
      { id: "3", title: "슬랙 컨펌 자동 폴링" },
      { id: "4", title: "CI 푸시 조율" },
    ]);
    expect(pairs.map((p) => [p.a.id, p.b.id])).toEqual([["1", "2"]]);
    expect(pairs[0].score).toBe(0.8);
  });
});

describe("injectionStats", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  const day = 86_400_000;
  const row = (id: string, ago: number, projectId: string | null, g: string[], t: string[], o: string[]): InjectionRow => ({
    id, createdAt: new Date(now.getTime() - ago * day), actorName: "agent", cwd: "/x", projectId, via: "SessionStart", mode: "compact", gistIds: g, titleIds: t, omittedIds: o, chars: 9000,
  });
  const lessons = [
    { id: "a", title: "A", projectId: null, stack: null, createdAt: now },
    { id: "b", title: "B", projectId: null, stack: null, createdAt: now },
    { id: "c", title: "C", projectId: "p", stack: null, createdAt: now },
  ];

  it("프로젝트별 7일/기간 횟수, 레슨별 횟수·조회 수, 정리 후보", () => {
    const s = injectionStats({
      rows: [row("1", 1, "p", ["a"], ["b"], []), row("2", 10, null, ["a"], [], ["b"]), row("3", 2, "p", [], ["a"], ["b"])],
      reads: [{ lessonId: "a" }, { lessonId: "a" }],
      lessons,
      projects: [{ id: "p", name: "P" }],
      days: 30,
      now,
    });
    expect(s.totals).toEqual({ injections: 3, last7: 2, reads: 2 });
    expect(s.byProject).toEqual([
      { projectId: "p", projectName: "P", last7: 2, lastN: 2 },
      { projectId: null, projectName: null, last7: 0, lastN: 1 },
    ]);
    expect(s.lessons.find((l) => l.id === "a")).toMatchObject({ gist: 2, titleOnly: 1, omitted: 0, reads: 2 });
    expect(s.cleanup.alwaysTruncated.map((l) => l.id)).toEqual(["b"]);
    expect(s.cleanup.neverInjected.map((l) => l.id)).toEqual(["c"]);
    expect(s.recent[0].id).toBe("1");
  });

  it("ondemand 는 '한 번도 안 들어감' 후보가 아니다(설계상 주입 안 함), 레슨 행에 scope·mode", () => {
    const ls = [...lessons, { id: "od", title: "OD", projectId: null, stack: null, mode: "ondemand", createdAt: now }, { id: "me", title: "ME", projectId: null, stack: null, userId: "u1", createdAt: now }];
    const s = injectionStats({ rows: [row("1", 1, "p", ["a", "b"], [], [])], reads: [], lessons: ls, projects: [], days: 30, now });
    expect(s.cleanup.neverInjected.map((l) => l.id)).toEqual(["c", "me"]);
    expect(s.lessons.find((l) => l.id === "od")).toMatchObject({ scope: "global", mode: "ondemand" });
    expect(s.lessons.find((l) => l.id === "me")).toMatchObject({ scope: "personal", mode: "default" });
  });

  it("'늘 잘림' 은 brief(이어가기) 기록으로는 판단하지 않는다", () => {
    const brief = { ...row("9", 1, "p", [], [], ["a", "b"]), mode: "brief" };
    const s = injectionStats({ rows: [row("1", 1, "p", ["a"], ["b"], []), brief], reads: [], lessons, projects: [], days: 30, now });
    expect(s.cleanup.alwaysTruncated.map((l) => l.id)).toEqual(["b"]);
    const onlyBrief = injectionStats({ rows: [brief], reads: [], lessons, projects: [], days: 30, now });
    expect(onlyBrief.cleanup.alwaysTruncated).toEqual([]);
    expect(onlyBrief.cleanup.neverInjected.map((l) => l.id)).toEqual(["c"]);
  });

  // 2026-10-11: 'SessionStart 0건' 으로 보였다 — 최근 목록(CLI 10건)이 잦은 PostToolUse 에 묻혀서. 훅·모드별 횟수를 따로 낸다.
  it("byVia — 훅·모드별 횟수(7일·기간), 많은 순", () => {
    const r = (id: string, ago: number, via: string, mode: string) => ({ ...row(id, ago, "p", [], [], []), via, mode });
    const s = injectionStats({
      rows: [r("1", 1, "PostToolUse", "compact"), r("2", 1, "PostToolUse", "compact"), r("3", 2, "SessionStart", "brief"), r("4", 9, "SessionStart", "compact"), r("5", 1, "UserPromptSubmit", "prompt")],
      reads: [],
      lessons,
      projects: [],
      days: 30,
      now,
    });
    expect(s.byVia).toEqual([
      { via: "PostToolUse", mode: "compact", count: 2, last7: 2 },
      { via: "SessionStart", mode: "brief", count: 1, last7: 1 },
      { via: "SessionStart", mode: "compact", count: 1, last7: 0 },
      { via: "UserPromptSubmit", mode: "prompt", count: 1, last7: 1 },
    ]);
  });

  it("'늘 잘림' 은 prompt(UserPromptSubmit) 기록으로도 판단하지 않는다", () => {
    const prompt = { ...row("8", 1, "p", ["b"], [], []), via: "UserPromptSubmit", mode: "prompt" };
    const s = injectionStats({ rows: [row("1", 1, "p", ["a"], ["b"], []), prompt], reads: [], lessons, projects: [], days: 30, now });
    expect(s.cleanup.alwaysTruncated.map((l) => l.id)).toEqual(["b"]);
  });

  // SubagentStart(sections=lessons, mode compact)는 개인 레슨을 설계상 제목만 넣는다 — 그건 '잘림' 이 아니다.
  it("'늘 잘림' 은 SubagentStart 기록의 개인 레슨 제목 줄로는 판단하지 않는다(다른 레슨의 잘림은 센다)", () => {
    const ls = [...lessons, { id: "me", title: "ME", projectId: null, stack: null, userId: "u1", createdAt: now }];
    const sub = { ...row("7", 1, "p", [], ["me", "b"], []), via: "SubagentStart" };
    const s = injectionStats({ rows: [row("1", 1, "p", ["a"], [], []), sub], reads: [], lessons: ls, projects: [], days: 30, now });
    expect(s.cleanup.alwaysTruncated.map((l) => l.id)).toEqual(["b"]);
    expect(s.lessons.find((l) => l.id === "me")).toMatchObject({ titleOnly: 1 }); // 레슨별 횟수에는 그대로 센다
    // 메인 세션 시작(SessionStart compact)에서도 제목만이면 그건 잘림이다
    const main = injectionStats({ rows: [row("1", 1, "p", ["a"], ["me"], []), sub], reads: [], lessons: ls, projects: [], days: 30, now });
    expect(main.cleanup.alwaysTruncated.map((l) => l.id)).toEqual(["b", "me"]);
  });

  it("개인이어도 필수(required) 레슨은 SubagentStart 행의 잘림을 근거로 센다(설계상 제목만인 건 기본 개인뿐)", () => {
    const ls = [...lessons, { id: "mereq", title: "MEREQ", projectId: null, stack: null, userId: "u1", mode: "required", createdAt: now }];
    const sub = { ...row("7", 1, "p", [], ["mereq"], []), via: "SubagentStart" };
    const s = injectionStats({ rows: [row("1", 1, "p", ["a"], [], []), sub], reads: [], lessons: ls, projects: [], days: 30, now });
    expect(s.cleanup.alwaysTruncated.map((l) => l.id)).toEqual(["mereq"]);
  });

  it("기록이 없으면 정리 후보(잘림·주입 0회)는 비운다", () => {
    const s = injectionStats({ rows: [], reads: [], lessons, projects: [], days: 30, now });
    expect(s.cleanup.alwaysTruncated).toEqual([]);
    expect(s.cleanup.neverInjected).toEqual([]);
  });
});

describe("log 헬퍼", () => {
  it("via 는 훅 네 종류만, 나머지는 unknown", () => {
    expect(normalizeVia("SessionStart")).toBe("SessionStart");
    expect(normalizeVia("PostToolUse")).toBe("PostToolUse");
    expect(normalizeVia("UserPromptSubmit")).toBe("UserPromptSubmit");
    expect(normalizeVia("SubagentStart")).toBe("SubagentStart");
    expect(normalizeVia("evil")).toBe("unknown");
    expect(normalizeVia(null)).toBe("unknown");
  });

  it("보고서 → id 묶음(not_applicable 은 빼고)", () => {
    expect(
      injectionIds({
        statuses: [
          { id: "a", scope: "global", status: "gist" },
          { id: "b", scope: "global", status: "title" },
          { id: "c", scope: "global", status: "omitted" },
          { id: "d", scope: "project", status: "not_applicable", reason: "other_project" },
        ],
      }),
    ).toEqual({ gistIds: ["a"], titleIds: ["b"], omittedIds: ["c"] });
  });

  it("brief: 출력에 id 가 보인 레슨 = 제목만, 대상인데 안 보인 레슨(전역 등) = 잘림", () => {
    const lessons = [
      { id: "g1", title: "전역", body: "x", projectId: null, stack: null },
      { id: "p1", title: "프로젝트", body: "x", projectId: "p", stack: null },
      { id: "o1", title: "남의 것", body: "x", projectId: "o", stack: null },
      { id: "n1", title: "넥스트", body: "x", projectId: null, stack: "next" },
      { id: "i1", title: "ios", body: "x", projectId: null, stack: "ios" },
    ];
    const md = renderBrief({ workspaceName: "W", projectId: "p", projectName: "P", projectStack: ["next"], lessons, tasks: [], me: [], counts: { docs: 0, decisions: 0, risks: 0, glossary: 0 } });
    expect(briefInjectionIds(md, lessons, "p", ["next"])).toEqual({ gistIds: [], titleIds: ["p1", "n1"], omittedIds: ["g1"] });
  });

  it("brief: 남의 개인 레슨·ondemand 는 대상이 아니라 기록하지 않는다, 내 개인 레슨은 기록한다", () => {
    const lessons = [
      { id: "g1", title: "전역", body: "x", projectId: null, stack: null },
      { id: "m1", title: "내 것", body: "x", projectId: null, stack: null, userId: "me" },
      { id: "y1", title: "남의 것", body: "x", projectId: null, stack: null, userId: "you" },
      { id: "od", title: "필요할 때만", body: "x", projectId: "p", stack: null, mode: "ondemand" },
    ];
    const md = renderBrief({ workspaceName: "W", projectId: "p", projectName: "P", projectStack: [], lessons, personId: "me", tasks: [], me: [], counts: { docs: 0, decisions: 0, risks: 0, glossary: 0 } });
    expect(briefInjectionIds(md, lessons, "p", [], "me")).toEqual({ gistIds: [], titleIds: ["m1"], omittedIds: ["g1"] });
  });
});

// sections=project(PostToolUse 델타)는 프로젝트 범위만 싣는다 — '세션 시작에서 늘 잘림' 판단에 섞지 않는다.
describe("injectionStats — project(델타) 기록", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  const lessons = [{ id: "a", title: "A", projectId: "p", stack: null, createdAt: now }];
  it("project 모드 기록만 있으면 '늘 잘림' 후보가 없고, 레슨 횟수에는 센다", () => {
    const r: InjectionRow = { id: "1", createdAt: now, actorName: null, cwd: "/x", projectId: "p", via: "PostToolUse", mode: "project", gistIds: [], titleIds: ["a"], omittedIds: [], chars: 2000 };
    const s = injectionStats({ rows: [r], reads: [], lessons, projects: [], days: 30, now });
    expect(s.cleanup.alwaysTruncated).toEqual([]);
    expect(s.lessons[0]).toMatchObject({ titleOnly: 1 });
  });
});
