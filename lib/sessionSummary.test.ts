import { describe, expect, it } from "vitest";
import { relativeTime, summarizeSessions, type SessionLike } from "./sessionSummary";

const NOW = new Date("2026-10-09T12:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const s = (over: Partial<SessionLike> & { id: string }): SessionLike => ({
  externalId: "ext-" + over.id,
  project: null,
  cwd: null,
  status: "active",
  startedAt: ago(600),
  endedAt: null,
  lastSeenAt: null,
  _count: { items: 0 },
  ...over,
});

describe("summarizeSessions — lastSeenAt", () => {
  it("lastSeenAt 이 있으면 endedAt·startedAt 보다 우선해 활동 시각·정렬·active 판정에 쓴다", () => {
    const r = summarizeSessions(
      [
        s({ id: "old", startedAt: ago(1), lastSeenAt: ago(120) }), // 시작은 최근이지만 마지막 활동은 2시간 전
        s({ id: "live", startedAt: ago(500), lastSeenAt: ago(2) }),
      ],
      NOW,
    );
    expect(r.top.map((t) => t.id)).toEqual(["live", "old"]);
    expect(r.top[0].updatedAt).toBe(ago(2));
    expect(r.lastActivityAt).toBe(ago(2));
    expect(r.active).toBe(1);
  });
  it("lastSeenAt 이 없으면 endedAt → startedAt 으로 대체한다", () => {
    const r = summarizeSessions([s({ id: "e", status: "ended", endedAt: ago(7), lastSeenAt: undefined })], NOW);
    expect(r.top[0].updatedAt).toBe(ago(7));
  });
});

describe("summarizeSessions", () => {
  it("빈 목록", () => {
    expect(summarizeSessions([], NOW)).toEqual({ active: 0, recent: 0, lastActivityAt: null, top: [] });
  });

  it("active 는 활성 상태 + 10분 이내, recent 는 24시간 이내", () => {
    const r = summarizeSessions(
      [
        s({ id: "a", lastSeenAt: ago(5) }),
        s({ id: "b", lastSeenAt: ago(30) }), // active 지만 오래됨 → recent 만
        s({ id: "c", status: "ended", endedAt: ago(3) }), // 종료 → recent 만
        s({ id: "d", startedAt: ago(60 * 30) }), // 24h 밖
      ],
      NOW,
    );
    expect(r.active).toBe(1);
    expect(r.recent).toBe(3);
  });

  it("활동 시각은 lastSeenAt → endedAt → startedAt 순, top 은 최신순 3개", () => {
    const r = summarizeSessions(
      [
        s({ id: "1", startedAt: ago(100) }),
        s({ id: "2", lastSeenAt: ago(2), project: "반장" }),
        s({ id: "3", status: "ended", endedAt: ago(20) }),
        s({ id: "4", lastSeenAt: ago(50), _count: { items: 7 } }),
      ],
      NOW,
    );
    expect(r.top.map((t) => t.id)).toEqual(["2", "3", "4"]);
    expect(r.top[0]).toMatchObject({ title: "반장", status: "active", itemCount: 0, updatedAt: ago(2) });
    expect(r.lastActivityAt).toBe(ago(2));
  });

  it("제목은 project → cwd 마지막 경로 → externalId", () => {
    const r = summarizeSessions(
      [s({ id: "x", cwd: "/Users/a/dev/teamspace/", lastSeenAt: ago(1) }), s({ id: "y", lastSeenAt: ago(2) })],
      NOW,
    );
    expect(r.top.map((t) => t.title)).toEqual(["teamspace", "ext-y"]);
  });

  it("잘못된 날짜는 건너뜀", () => {
    const r = summarizeSessions([s({ id: "z", startedAt: "nope" })], NOW);
    expect(r).toEqual({ active: 0, recent: 0, lastActivityAt: null, top: [] });
  });
});

describe("relativeTime", () => {
  it("단계별 표기", () => {
    expect(relativeTime(ago(0), NOW)).toBe("방금 전");
    expect(relativeTime(ago(5), NOW)).toBe("5분 전");
    expect(relativeTime(ago(180), NOW)).toBe("3시간 전");
    expect(relativeTime(ago(60 * 48), NOW)).toBe("2일 전");
  });
});
