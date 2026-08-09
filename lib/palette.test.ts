import { describe, it, expect } from "vitest";
import { scoreItem, rankItems, moveCursor, NAV_COMMANDS, type PaletteItem } from "@/lib/palette";

const doc = (title: string, hint?: string): PaletteItem => ({
  id: `d:${title}`,
  kind: "doc",
  title,
  hint,
  href: "/p/x",
});

describe("scoreItem", () => {
  it("빈 질의는 전부 통과시킨다(팔레트를 열면 목록이 보여야 한다)", () => {
    expect(scoreItem(doc("아무 문서"), "")).not.toBeNull();
    expect(scoreItem(doc("아무 문서"), "   ")).not.toBeNull();
  });

  it("연속 부분문자열이 맞으면 통과", () => {
    expect(scoreItem(doc("설계 스펙"), "스펙")).not.toBeNull();
  });

  it("대소문자를 무시한다", () => {
    expect(scoreItem(doc("BlockNote 설계"), "blocknote")).not.toBeNull();
  });

  it("흩어진 글자도 순서만 맞으면 잡는다", () => {
    expect(scoreItem(doc("DatabaseView"), "dbv")).not.toBeNull();
  });

  it("순서가 어긋나면 안 잡는다 — 왜 떴는지 설명이 안 되면 안 된다", () => {
    expect(scoreItem(doc("abc"), "cba")).toBeNull();
  });

  it("아예 없는 글자는 안 잡는다", () => {
    expect(scoreItem(doc("설계 스펙"), "zzz")).toBeNull();
  });

  it("제목이 아니라 보조설명에서 맞으면 점수가 크게 깎인다", () => {
    const inTitle = scoreItem(doc("로요 설계"), "로요")!;
    const inHint = scoreItem(doc("무관한 제목", "로요 프로젝트"), "로요")!;
    expect(inHint.score).toBeLessThan(inTitle.score);
  });
});

describe("rankItems — 순위", () => {
  it("앞에서 맞은 것이 뒤에서 맞은 것보다 위로", () => {
    const r = rankItems([doc("나중에 설계"), doc("설계 문서")], "설계");
    expect(r[0].item.title).toBe("설계 문서");
  });

  it("연속 매칭이 흩어진 매칭보다 위로", () => {
    const r = rankItems([doc("D a t a B a s e V"), doc("dbv 노트")], "dbv");
    expect(r[0].item.title).toBe("dbv 노트");
  });

  it("같은 점수면 명령이 문서보다 위로", () => {
    const cmd: PaletteItem = { id: "c", kind: "command", title: "설정", href: "/settings" };
    const d = doc("설정");
    expect(rankItems([d, cmd], "설정")[0].item.kind).toBe("command");
  });

  it("동점이면 매번 같은 순서 — 근육 기억이 생기려면 흔들리면 안 된다", () => {
    const items = [doc("가나"), doc("가나"), doc("가나다")].map((d, i) => ({ ...d, id: `x${i}` }));
    const a = rankItems(items, "가나").map((s) => s.item.id);
    const b = rankItems([...items].reverse(), "가나").map((s) => s.item.id);
    expect(a).toEqual(b);
  });

  it("매칭 안 되는 건 아예 빠진다", () => {
    const r = rankItems([doc("설계"), doc("전혀다름")], "설계");
    expect(r).toHaveLength(1);
  });

  it("limit 을 넘지 않는다", () => {
    const many = Array.from({ length: 100 }, (_, i) => doc(`문서 ${i}`));
    expect(rankItems(many, "문서", 5)).toHaveLength(5);
  });

  it("빈 질의에서도 종류 가중치 순으로 나온다", () => {
    const r = rankItems([doc("문서"), { id: "c", kind: "command", title: "명령", href: "/x" }], "");
    expect(r[0].item.kind).toBe("command");
  });
});

describe("moveCursor", () => {
  it("아래로 감긴다", () => {
    expect(moveCursor(2, 1, 3)).toBe(0);
  });
  it("위로 감긴다", () => {
    expect(moveCursor(0, -1, 3)).toBe(2);
  });
  it("빈 목록은 0", () => {
    expect(moveCursor(5, 1, 0)).toBe(0);
  });
  it("일반 이동", () => {
    expect(moveCursor(0, 1, 3)).toBe(1);
    expect(moveCursor(2, -1, 3)).toBe(1);
  });
});

describe("NAV_COMMANDS", () => {
  it("모든 항목이 갈 곳을 갖는다", () => {
    for (const c of NAV_COMMANDS) {
      expect(c.href, c.title).toBeTruthy();
      expect(c.kind).toBe("command");
    }
  });

  it("id 가 겹치지 않는다", () => {
    const ids = NAV_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
