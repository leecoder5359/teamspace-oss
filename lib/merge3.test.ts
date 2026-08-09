import { describe, it, expect } from "vitest";
import { diffLines, merge3, formatConflicts } from "@/lib/merge3";

const L = (s: string) => s.split("\n");

describe("diffLines", () => {
  it("변경 없으면 훅이 없다", () => {
    expect(diffLines(L("a\nb\nc"), L("a\nb\nc"))).toEqual([]);
  });

  it("중간 한 줄 교체", () => {
    expect(diffLines(L("a\nb\nc"), L("a\nX\nc"))).toEqual([{ start: 1, end: 2, lines: ["X"] }]);
  });

  it("끝에 추가", () => {
    expect(diffLines(L("a\nb"), L("a\nb\nc"))).toEqual([{ start: 2, end: 2, lines: ["c"] }]);
  });

  it("삭제", () => {
    expect(diffLines(L("a\nb\nc"), L("a\nc"))).toEqual([{ start: 1, end: 2, lines: [] }]);
  });

  it("떨어진 두 곳 변경은 훅 두 개", () => {
    const h = diffLines(L("a\nb\nc\nd\ne"), L("A\nb\nc\nd\nE"));
    expect(h).toHaveLength(2);
    expect(h[0]).toEqual({ start: 0, end: 1, lines: ["A"] });
    expect(h[1]).toEqual({ start: 4, end: 5, lines: ["E"] });
  });
});

describe("merge3 — 깨끗하게 병합되는 경우", () => {
  const base = "제목\n\n첫 문단\n\n둘째 문단\n";

  it("양쪽이 서로 다른 곳을 고치면 둘 다 살린다", () => {
    const mine = "제목\n\n첫 문단 (내가 고침)\n\n둘째 문단\n";
    const theirs = "제목\n\n첫 문단\n\n둘째 문단 (남이 고침)\n";
    const r = merge3(base, mine, theirs);
    expect(r.conflicts).toBe(0);
    expect(r.text).toContain("첫 문단 (내가 고침)");
    expect(r.text).toContain("둘째 문단 (남이 고침)");
  });

  it("한쪽만 고쳤으면 그대로", () => {
    const mine = "제목\n\n첫 문단 (내가 고침)\n\n둘째 문단\n";
    expect(merge3(base, mine, base)).toMatchObject({ conflicts: 0, text: mine });
    expect(merge3(base, base, mine)).toMatchObject({ conflicts: 0, text: mine });
  });

  it("양쪽이 똑같이 고쳤으면 한 번만 적용", () => {
    const same = "제목\n\n첫 문단 (같은 수정)\n\n둘째 문단\n";
    const r = merge3(base, same, same);
    expect(r.conflicts).toBe(0);
    expect(r.text).toBe(same);
    expect(r.text.match(/같은 수정/g)).toHaveLength(1);
  });

  it("아무도 안 고쳤으면 원본", () => {
    expect(merge3(base, base, base)).toMatchObject({ conflicts: 0, text: base });
  });

  it("서로 다른 위치에 추가", () => {
    const mine = "머리말\n" + base;
    const theirs = base + "꼬리말\n";
    const r = merge3(base, mine, theirs);
    expect(r.conflicts).toBe(0);
    expect(r.text.startsWith("머리말")).toBe(true);
    expect(r.text.trimEnd().endsWith("꼬리말")).toBe(true);
  });
});

describe("merge3 — 충돌", () => {
  const base = "제목\n\n본문\n";

  it("같은 줄을 다르게 고치면 충돌로 표시하고 양쪽을 모두 남긴다", () => {
    const mine = "제목\n\n내가 쓴 본문\n";
    const theirs = "제목\n\n남이 쓴 본문\n";
    const r = merge3(base, mine, theirs);
    expect(r.conflicts).toBe(1);
    // 무엇도 버리지 않는다 — 이게 이 함수의 존재 이유다
    expect(r.text).toContain("내가 쓴 본문");
    expect(r.text).toContain("남이 쓴 본문");
    expect(r.text).toContain("<<<<<<<");
    expect(r.text).toContain(">>>>>>>");
  });

  it("충돌 마커에 어느 쪽인지 라벨이 붙는다", () => {
    const r = merge3(base, "제목\n\nA\n", "제목\n\nB\n");
    expect(r.text).toContain("<<<<<<< 내 편집");
    expect(r.text).toContain(">>>>>>> 서버(다른 곳에서 저장됨)");
  });

  it("충돌 구간이 둘이면 conflicts=2", () => {
    const b = "1\n2\n3\n4\n5\n";
    const m = "1x\n2\n3\n4\n5x\n";
    const t = "1y\n2\n3\n4\n5y\n";
    expect(merge3(b, m, t).conflicts).toBe(2);
  });

  it("충돌이 있어도 겹치지 않는 변경은 정상 병합된다", () => {
    const b = "1\n2\n3\n";
    const m = "1\n2changed\n3\n"; // 내가 2행
    const t = "1\n2other\n3fromThem\n"; // 남이 2행(충돌) + 3행(단독)
    const r = merge3(b, m, t);
    expect(r.conflicts).toBe(1);
    expect(r.text).toContain("3fromThem");
  });
});

describe("merge3 — 경계", () => {
  it("빈 문서", () => {
    expect(merge3("", "", "")).toMatchObject({ conflicts: 0, text: "" });
  });

  it("base 가 비고 양쪽이 각각 썼으면 충돌", () => {
    const r = merge3("", "내 글\n", "남의 글\n");
    expect(r.conflicts).toBe(1);
    expect(r.text).toContain("내 글");
    expect(r.text).toContain("남의 글");
  });

  it("CRLF 를 LF 로 정규화해 비교한다", () => {
    const r = merge3("a\r\nb\r\n", "a\r\nB\r\n", "a\r\nb\r\n");
    expect(r.conflicts).toBe(0);
    expect(r.text).toContain("B");
    expect(r.text).not.toContain("\r");
  });

  it("아주 긴 문서에서도 터지지 않는다", () => {
    const b = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    const m = b.replace("line 10", "line 10 mine");
    const t = b.replace("line 1500", "line 1500 theirs");
    const r = merge3(b, m, t);
    expect(r.conflicts).toBe(0);
    expect(r.text).toContain("line 10 mine");
    expect(r.text).toContain("line 1500 theirs");
  });
});

describe("formatConflicts", () => {
  it("충돌 구간 요약을 뽑는다", () => {
    const r = merge3("a\nb\nc\n", "a\nMINE\nc\n", "a\nTHEIRS\nc\n");
    const summary = formatConflicts(r.text);
    expect(summary).toHaveLength(1);
    expect(summary[0].mine).toContain("MINE");
    expect(summary[0].theirs).toContain("THEIRS");
  });

  it("충돌 없으면 빈 배열", () => {
    expect(formatConflicts("그냥 본문\n")).toEqual([]);
  });
});
