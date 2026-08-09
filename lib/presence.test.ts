import { describe, it, expect } from "vitest";
import { touch, viewersOf, summarize, pruneAll, type PresenceEntry } from "@/lib/presence";

const T0 = 1_700_000_000_000;
const TTL = 30_000;

const mk = (over: Partial<PresenceEntry> = {}): PresenceEntry => ({
  userId: "u1",
  name: "가나",
  pageId: "p1",
  at: T0,
  editing: false,
  ...over,
});

describe("touch — 하트비트 반영", () => {
  it("없으면 넣고 있으면 시각을 갱신한다(사람당 한 줄)", () => {
    let list: PresenceEntry[] = [];
    list = touch(list, mk());
    list = touch(list, mk({ at: T0 + 5000, editing: true }));
    expect(list).toHaveLength(1);
    expect(list[0].at).toBe(T0 + 5000);
    expect(list[0].editing).toBe(true);
  });

  it("같은 사람이라도 다른 페이지면 따로 센다", () => {
    let list: PresenceEntry[] = [];
    list = touch(list, mk());
    list = touch(list, mk({ pageId: "p2" }));
    expect(list).toHaveLength(2);
  });

  it("사람이 다르면 따로", () => {
    let list: PresenceEntry[] = [];
    list = touch(list, mk());
    list = touch(list, mk({ userId: "u2", name: "다라" }));
    expect(list).toHaveLength(2);
  });
});

describe("viewersOf — 지금 이 페이지를 보는 사람", () => {
  const list = [
    mk({ userId: "u1", name: "가나", at: T0 }),
    mk({ userId: "u2", name: "다라", at: T0 - 10_000 }),
    mk({ userId: "u3", name: "마바", at: T0 - 60_000 }), // 오래됨
    mk({ userId: "u4", name: "사아", pageId: "p2", at: T0 }), // 다른 페이지
  ];

  it("TTL 안에 있는 같은 페이지 사람만", () => {
    const v = viewersOf(list, "p1", T0, TTL);
    expect(v.map((x) => x.name)).toEqual(["가나", "다라"]);
  });

  it("자기 자신은 뺄 수 있다", () => {
    const v = viewersOf(list, "p1", T0, TTL, "u1");
    expect(v.map((x) => x.name)).toEqual(["다라"]);
  });

  it("최근 순으로 준다", () => {
    const v = viewersOf(list, "p1", T0, TTL);
    expect(v[0].at).toBeGreaterThanOrEqual(v[1].at);
  });

  it("아무도 없으면 빈 배열", () => {
    expect(viewersOf(list, "없는페이지", T0, TTL)).toEqual([]);
  });

  it("편집 중인 사람이 먼저 온다(같은 시각이면)", () => {
    const l = [
      mk({ userId: "a", name: "보는중", at: T0 }),
      mk({ userId: "b", name: "편집중", at: T0, editing: true }),
    ];
    expect(viewersOf(l, "p1", T0, TTL)[0].name).toBe("편집중");
  });
});

describe("pruneAll — 오래된 항목 정리", () => {
  it("TTL 두 배가 지난 것은 버린다(메모리 누수 방지)", () => {
    const list = [mk({ userId: "a", at: T0 }), mk({ userId: "b", at: T0 - 120_000 })];
    const kept = pruneAll(list, T0, TTL);
    expect(kept.map((x) => x.userId)).toEqual(["a"]);
  });

  it("전부 최신이면 그대로", () => {
    const list = [mk({ userId: "a", at: T0 })];
    expect(pruneAll(list, T0, TTL)).toHaveLength(1);
  });
});

describe("summarize — 사람 이름 요약", () => {
  it("적으면 그대로 나열", () => {
    expect(summarize(["가나", "다라"], 3)).toBe("가나, 다라");
  });

  it("많으면 '외 n명'", () => {
    expect(summarize(["가나", "다라", "마바", "사아"], 2)).toBe("가나, 다라 외 2명");
  });

  it("아무도 없으면 빈 문자열", () => {
    expect(summarize([], 3)).toBe("");
  });

  it("한 명이면 그 이름만", () => {
    expect(summarize(["가나"], 3)).toBe("가나");
  });
});
