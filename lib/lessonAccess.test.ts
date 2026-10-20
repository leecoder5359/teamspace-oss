import { describe, it, expect } from "vitest";
import {
  parseLessonListScope,
  lessonScopeWhere,
  teammateLessonWhere,
  copyDecision,
  canSetSharedWithTeam,
  promoteDecision,
} from "./lessonAccess";

const me = { personId: "me", role: "editor" as const };
const admin = { personId: "boss", role: "admin" as const };

describe("parseLessonListScope", () => {
  it("없음·빈칸 = null(종전 동작), team|mine|teammates 만 받는다", () => {
    expect(parseLessonListScope(null)).toEqual({ ok: true, scope: null });
    expect(parseLessonListScope("")).toEqual({ ok: true, scope: null });
    expect(parseLessonListScope("teammates")).toEqual({ ok: true, scope: "teammates" });
    expect(parseLessonListScope("mine")).toEqual({ ok: true, scope: "mine" });
    expect(parseLessonListScope("team")).toEqual({ ok: true, scope: "team" });
    expect(parseLessonListScope("all").ok).toBe(false);
  });
});

describe("lessonScopeWhere", () => {
  it("team = 개인 아닌 것, mine = 내 것(admin 이어도 내 것만), 사람을 모르면 mine 은 빈 결과", () => {
    expect(lessonScopeWhere("team", me)).toEqual({ userId: null });
    expect(lessonScopeWhere("mine", admin)).toEqual({ userId: "boss" });
    expect(lessonScopeWhere("mine", { personId: null, role: "editor" })).toEqual({ id: { in: [] } });
    expect(lessonScopeWhere(null, me)).toBeNull();
  });
});

describe("teammateLessonWhere", () => {
  it("활성 멤버 중 나를 뺀 사람의 공개 개인 레슨만(가져온 복사본 제외) — admin 도 같다", () => {
    expect(teammateLessonWhere(me, ["me", "b", "c"])).toEqual({ userId: { in: ["b", "c"] }, sharedWithTeam: true, copiedFromId: null });
    expect(teammateLessonWhere(admin, ["boss", "b"])).toEqual({ userId: { in: ["b"] }, sharedWithTeam: true, copiedFromId: null });
  });
  it("사람을 모르는 요청(발급자 미상 토큰)은 null — 라우트가 빈 목록을 낸다", () => {
    expect(teammateLessonWhere({ personId: null, role: "editor" }, ["b"])).toBeNull();
  });
});

describe("copyDecision", () => {
  const src = (x: Record<string, unknown> = {}) => ({ userId: "b", sharedWithTeam: true, copiedFromId: null, ...x });
  it("활성 팀원의 공개 개인 레슨만 ok", () => {
    expect(copyDecision(src(), me, true)).toBe("ok");
  });
  it("비공개·작성자 비활성·사람 미상·가져온 복사본은 not_found(404 — 있는지조차 알리지 않는다), admin 도 같다", () => {
    expect(copyDecision(src({ sharedWithTeam: false }), me, true)).toBe("not_found");
    expect(copyDecision(src({ sharedWithTeam: false }), admin, true)).toBe("not_found");
    expect(copyDecision(src(), me, false)).toBe("not_found");
    expect(copyDecision(src(), { personId: null, role: "editor" }, true)).toBe("not_found");
    expect(copyDecision(src({ copiedFromId: "ORIG" }), me, true)).toBe("not_found");
  });
  it("내 레슨은 own, 팀 레슨(개인 아님)은 team", () => {
    expect(copyDecision(src({ userId: "me" }), me, true)).toBe("own");
    expect(copyDecision(src({ userId: null }), me, true)).toBe("team");
  });
});

describe("canSetSharedWithTeam", () => {
  it("주인만 — admin 이라도 남의 것은 안 된다, 개인 레슨이 아니면 안 된다", () => {
    expect(canSetSharedWithTeam({ userId: "me" }, me)).toBe(true);
    expect(canSetSharedWithTeam({ userId: "me" }, admin)).toBe(false);
    expect(canSetSharedWithTeam({ userId: null }, me)).toBe(false);
  });
});

describe("promoteDecision", () => {
  it("admin + 개인 레슨만 ok", () => {
    expect(promoteDecision({ userId: "b" }, admin)).toBe("ok");
    expect(promoteDecision({ userId: "b" }, me)).toBe("forbidden");
    expect(promoteDecision({ userId: null }, admin)).toBe("not_personal");
  });
});
