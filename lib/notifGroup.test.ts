import { describe, it, expect } from "vitest";
import { groupNotifications, type NotifLike } from "./notifGroup";

const H = 3600_000;
const base = new Date("2026-10-09T12:00:00Z").getTime();
const NOW = new Date(base + 1000);
const n = (id: string, type: string, link: string | null, agoH: number, read = false, title = id): NotifLike => ({
  id, type, link, title, readAt: read ? new Date(base) : null, createdAt: new Date(base - agoH * H),
});

describe("groupNotifications", () => {
  it("같은 type+link 는 묶고 다른 link 는 분리", () => {
    const g = groupNotifications([n("a", "mention", "/x", 1), n("b", "mention", "/x", 2), n("c", "mention", "/y", 3)], NOW);
    expect(g.map((x) => [x.key, x.count])).toEqual([["mention|/x", 2], ["mention|/y", 1]]);
  });

  it("link null 은 빈 문자열 키로 묶인다", () => {
    const g = groupNotifications([n("a", "due", null, 1), n("b", "due", null, 2)], NOW);
    expect(g).toHaveLength(1);
    expect(g[0].key).toBe("due|");
    expect(g[0].link).toBeNull();
  });

  it("24시간 경계: 정확히 24h 는 같은 묶음, 초과는 새 묶음", () => {
    const same = groupNotifications([n("a", "due", "/x", 0), n("b", "due", "/x", 24)], NOW);
    expect(same).toHaveLength(1);
    const split = groupNotifications([n("a", "due", "/x", 0), n("b", "due", "/x", 24.01), n("c", "due", "/x", 25)], NOW);
    expect(split.map((g) => g.ids)).toEqual([["a"], ["b", "c"]]);
  });

  it("읽음/미읽음 혼합 집계·sample 최대 3·최신순", () => {
    const g = groupNotifications([
      n("a", "shared", "/x", 4, true, "t4"), n("b", "shared", "/x", 1, false, "t1"),
      n("c", "shared", "/x", 3, false, "t3"), n("d", "shared", "/x", 2, true, "t2"),
    ], NOW)[0];
    expect(g.count).toBe(4);
    expect(g.unread).toBe(2);
    expect(g.sample).toEqual(["t1", "t2", "t3"]);
    expect(g.ids).toEqual(["b", "d", "c", "a"]);
  });

  it("묶음은 latestAt 내림차순", () => {
    const g = groupNotifications([n("a", "due", "/x", 5), n("b", "mention", "/y", 1)], NOW);
    expect(g.map((x) => x.type)).toEqual(["mention", "due"]);
  });

  it("미래 시각은 now 로 눌러 계산한다", () => {
    const g = groupNotifications([{ ...n("f", "due", "/x", -5), createdAt: new Date(base + 5 * H) }], NOW);
    expect(g[0].latestAt).toBe(NOW.toISOString());
  });

  it("단일 항목도 묶음이고 입력은 바뀌지 않는다", () => {
    const input = [n("a", "due", "/x", 5), n("b", "due", "/x", 1)];
    const copy = [...input];
    const g = groupNotifications(input, NOW);
    expect(input).toEqual(copy);
    expect(groupNotifications([n("z", "due", "/z", 1)], NOW)[0].count).toBe(1);
    expect(g[0].latestAt).toBe(new Date(base - H).toISOString());
  });
});
