import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { LOCK_NAME_RE, lockNameError, parseTtlFlag } from "./pushLockRules";
import { isActive, isSameHolder, lockNameFromParam, lockView, ttlMinutesOf, LockError } from "./pushLock";
import { liveSessionWhere, sessionGitFields, shortWorktree } from "./liveSessions";

// Console 4 — 공유 브랜치 푸시·배포 잠금의 순수 규칙.
describe("잠금 이름 검증", () => {
  it.each(["banjang/develop", "teamspace/main", "deploy:teamspace", "a", "x.y_z-1/feat/abc"])("허용: %s", (n) => expect(lockNameError(n)).toBeNull());
  it.each(["", "Banjang/develop", "/develop", "-x", "a b", "a;b", "한글/main", "a".repeat(82)])("거부: %j", (n) => expect(lockNameError(n)).not.toBeNull());
  it("81자까지", () => expect(LOCK_NAME_RE.test("a".repeat(81))).toBe(true));
  it("문자열이 아니면 거부", () => expect(lockNameError(undefined)).toMatch(/필요/));
});

describe("--ttl 파싱", () => {
  it.each([
    ["30m", 30],
    ["2h", 120],
    ["1h30m", 90],
    ["45", 45],
    [" 4H ", 240],
  ])("%s → %d분", (s, m) => expect(parseTtlFlag(s)).toBe(m));
  it.each(["", "h", "m", "1d", "1.5h", "-3m", "30s"])("형식 오류: %j", (s) => expect(parseTtlFlag(s)).toBeNull());
});

describe("ttlMinutesOf (서버)", () => {
  it("없으면 기본 30분", () => expect(ttlMinutesOf(undefined)).toBe(30));
  it("1~240 정수", () => {
    expect(ttlMinutesOf(1)).toBe(1);
    expect(ttlMinutesOf(240)).toBe(240);
    expect(ttlMinutesOf("60")).toBe(60);
  });
  it.each([0, 241, 1.5, "abc", -1])("범위 밖·정수 아님 → 400: %j", (v) => {
    try {
      ttlMinutesOf(v);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(LockError);
      expect((e as LockError).status).toBe(400);
    }
  });
});

const now = new Date("2026-10-09T10:00:00Z");
const base = {
  id: "l1",
  name: "banjang/develop",
  holderName: "mac-mini-claude",
  holderUserId: "u1",
  holderSession: "s1",
  cwd: "/w/banjang",
  branch: "develop",
  note: "CI 대기",
  takenAt: new Date("2026-10-09T09:40:00Z"),
  expiresAt: new Date("2026-10-09T10:10:00Z"),
  releasedAt: null,
};

describe("활성·보유자 판정", () => {
  it("만료·해제면 빈 잠금", () => {
    expect(isActive(base, now)).toBe(true);
    expect(isActive({ ...base, expiresAt: now }, now)).toBe(false);
    expect(isActive({ ...base, releasedAt: now }, now)).toBe(false);
  });
  it("같은 토큰 이름·User·세션이면 같은 보유자", () => expect(isSameHolder(base, { name: "mac-mini-claude", userId: "u1", session: "s1" })).toBe(true));
  it("다른 세션이면 다른 보유자(같은 토큰이라도)", () => expect(isSameHolder(base, { name: "mac-mini-claude", userId: "u1", session: "s2" })).toBe(false));
  it("한쪽에 세션이 없으면 이름으로만", () => {
    expect(isSameHolder(base, { name: "mac-mini-claude", userId: "u1", session: null })).toBe(true);
    expect(isSameHolder({ ...base, holderSession: null }, { name: "mac-mini-claude", userId: "u1", session: "s9" })).toBe(true);
  });
  it("다른 이름·다른 User 면 다른 보유자", () => {
    expect(isSameHolder(base, { name: "laptop", userId: "u1", session: "s1" })).toBe(false);
    expect(isSameHolder(base, { name: "mac-mini-claude", userId: "u2", session: "s1" })).toBe(false);
  });
});

describe("lockView", () => {
  it("나이·남은 시간·mine", () => {
    const v = lockView(base, now, { name: "mac-mini-claude", userId: "u1", session: "s1" });
    expect(v).toMatchObject({ name: "banjang/develop", active: true, ageMin: 20, remainingMin: 10, mine: true, note: "CI 대기" });
    expect(lockView(base, now, { name: "other", userId: "u2" }).mine).toBe(false);
    expect(lockView({ ...base, releasedAt: now }, now).remainingMin).toBe(0);
  });
});

describe("lockNameFromParam", () => {
  it("인코딩된 슬래시를 푼다", () => expect(lockNameFromParam("banjang%2Fdevelop")).toBe("banjang/develop"));
  it("이미 풀린 값은 그대로", () => expect(lockNameFromParam("deploy:teamspace")).toBe("deploy:teamspace"));
  it("깨진 인코딩은 그대로(검증에서 거부)", () => expect(lockNameFromParam("a%zz")).toBe("a%zz"));
});

describe("라이브 세션 규칙", () => {
  it("저장소 필드: 빈 값은 빼서 기존 값을 유지", () => {
    expect(sessionGitFields({ branch: "develop", repo: "banjang", worktree: "/w/banjang-wt" })).toEqual({ branch: "develop", repo: "banjang", worktreePath: "/w/banjang-wt" });
    expect(sessionGitFields({ branch: "  ", repo: 3 })).toEqual({});
  });
  it("2시간 창: 마지막 활동 또는(없으면) 시작 시각", () => {
    const w = liveSessionWhere("ws", now);
    expect(w.status).toBe("active");
    expect(w.OR[0]).toEqual({ lastSeenAt: { gte: new Date("2026-10-09T08:00:00Z") } });
    expect(w.OR[1]).toEqual({ lastSeenAt: null, startedAt: { gte: new Date("2026-10-09T08:00:00Z") } });
  });
  it("워크트리 짧은 이름", () => {
    expect(shortWorktree("/Users/u/dev/teamspace/.claude/worktrees/agent-abc/")).toBe("agent-abc");
    expect(shortWorktree(null)).toBeNull();
  });
});
