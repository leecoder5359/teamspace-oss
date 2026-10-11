import { describe, it, expect } from "vitest";
import { buildClusters, chunkClusters, computeSignals, type HygieneLesson } from "./signals";

const now = new Date("2026-10-12T02:00:00Z");
const old = new Date("2026-08-01T00:00:00Z");
const L = (id: string, o: Partial<HygieneLesson> = {}): HygieneLesson => ({
  id,
  title: `레슨 ${id}`,
  body: "본문",
  projectId: null,
  stack: null,
  userId: null,
  mode: "default",
  keywords: [],
  createdAt: old,
  ...o,
});

describe("computeSignals", () => {
  it("창 안 주입·조회 0회인 레슨을 stale 로 — 단 required·새 레슨·개인 레슨은 제외", () => {
    const s = computeSignals({
      lessons: [L("a"), L("b"), L("c"), L("r", { mode: "required" }), L("n", { createdAt: new Date("2026-10-10T00:00:00Z") }), L("p", { userId: "u1" })],
      injections: [{ projectId: null, gistIds: ["a"], titleIds: [] }],
      reads: [{ lessonId: "b" }],
      projects: [],
      now,
    });
    expect(s.stale.map((x) => x.id)).toEqual(["c"]);
  });

  it("세션이 없던 프로젝트·스택의 레슨은 stale 이 아니다(쓸 기회가 없었다)", () => {
    const s = computeSignals({
      lessons: [L("p1", { projectId: "P1" }), L("p2", { projectId: "P2" }), L("st", { stack: "next" }), L("st2", { stack: "rails" })],
      injections: [{ projectId: "P1", gistIds: [], titleIds: [] }],
      reads: [],
      projects: [{ id: "P1", stack: ["next"] }, { id: "P2", stack: ["rails"] }],
      now,
    });
    expect(s.stale.map((x) => x.id).sort()).toEqual(["p1", "st"]);
  });

  it("주입 기록이 하나도 없으면 stale 은 비어 있다", () => {
    const s = computeSignals({ lessons: [L("a")], injections: [], reads: [], projects: [], now });
    expect(s.stale).toEqual([]);
  });

  it("ondemand + 빈 키워드, 비슷한 제목(자카드≥0.6), 필수 15개 초과", () => {
    const req = Array.from({ length: 16 }, (_, i) => L(`r${i}`, { mode: "required", title: `필수 규칙 번호 ${i} 고유어${i}` }));
    const s = computeSignals({
      lessons: [
        L("o1", { mode: "ondemand" }),
        L("o2", { mode: "ondemand", keywords: ["x1"] }),
        L("t1", { title: "슬랙 승인 카드 채널 명시" }),
        L("t2", { title: "슬랙 승인 카드 채널 명시 필수" }),
        L("pp", { mode: "ondemand", userId: "u" }),
        ...req,
      ],
      injections: [],
      reads: [],
      projects: [],
      now,
    });
    expect(s.ondemandNoKeywords.map((x) => x.id)).toEqual(["o1"]);
    expect(s.similarPairs.map((p) => [p.a.id, p.b.id])).toEqual([["t1", "t2"]]);
    expect(s.requiredOver?.count).toBe(16);
    expect(s.requiredOver?.max).toBe(15);
  });
});

describe("buildClusters / chunkClusters", () => {
  it("비슷한 쌍은 한 묶음, 나머지는 하나씩, 필수 과다는 required 묶음", () => {
    const lessons = [L("a", { title: "가 나 다 라" }), L("b", { title: "가 나 다 라 마" }), L("c", { projectId: "P" }), L("d", { mode: "ondemand" })];
    const s = computeSignals({ lessons, injections: [{ projectId: "P", gistIds: ["a", "b"], titleIds: [] }], reads: [], projects: [], now, requiredMax: -1 });
    const cl = buildClusters(s, lessons);
    expect(cl.find((c) => c.lessonIds.includes("a"))?.lessonIds.sort()).toEqual(["a", "b"]);
    expect(cl.find((c) => c.lessonIds.includes("c"))?.scopeKey).toBe("project:P");
    expect(cl.some((c) => c.lessonIds.length === 1 && c.lessonIds[0] === "d")).toBe(true);
    expect(cl.some((c) => c.scopeKey === "required")).toBe(true);
  });

  it("범위별로 나누고 한 덩어리 레슨 수 상한을 지킨다(묶음은 쪼개지 않음)", () => {
    const cl = [
      { scopeKey: "global", lessonIds: ["a", "b"], reasons: [] },
      { scopeKey: "global", lessonIds: ["c"], reasons: [] },
      { scopeKey: "project:P", lessonIds: ["d"], reasons: [] },
    ];
    const ch = chunkClusters(cl, 2);
    expect(ch.map((c) => c.flatMap((x) => x.lessonIds))).toEqual([["a", "b"], ["c"], ["d"]]);
  });
});
