import { describe, it, expect } from "vitest";
import {
  scoreCandidate,
  passesFilters,
  rankSearch,
  countOccurrences,
  makeSnippet,
  usesTrigramIndex,
  type Candidate,
} from "@/lib/searchRank";

const NOW = Date.parse("2026-08-08T00:00:00Z");
const c = (over: Partial<Candidate> = {}): Candidate => ({
  id: "1",
  kind: "doc",
  title: "제목",
  body: "본문",
  updatedAt: "2026-08-08T00:00:00Z",
  ...over,
});

describe("countOccurrences", () => {
  it("겹치지 않게 센다", () => {
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("배포 배포 배포", "배포")).toBe(3);
    expect(countOccurrences("없음", "배포")).toBe(0);
    expect(countOccurrences("아무거나", "")).toBe(0);
  });
});

describe("scoreCandidate — 제목 신호가 본문을 이긴다", () => {
  it("정확일치 > 앞부분 > 포함", () => {
    const exact = scoreCandidate(c({ title: "배포" }), "배포", NOW);
    const starts = scoreCandidate(c({ title: "배포 절차" }), "배포", NOW);
    const has = scoreCandidate(c({ title: "야간 배포 절차" }), "배포", NOW);
    expect(exact).toBeGreaterThan(starts);
    expect(starts).toBeGreaterThan(has);
  });

  it("제목 포함이 본문 다수 등장을 이긴다 — 본문 우연 일치가 제목을 밀어내면 안 된다", () => {
    const inTitle = scoreCandidate(c({ title: "배포 절차", body: "" }), "배포", NOW);
    const inBodyMany = scoreCandidate(c({ title: "무관", body: "배포 ".repeat(50) }), "배포", NOW);
    expect(inTitle).toBeGreaterThan(inBodyMany);
  });

  it("본문 등장 횟수는 로그로 눌러 긴 문서가 항상 이기지 않게 한다", () => {
    const few = scoreCandidate(c({ title: "무관", body: "배포 배포" }), "배포", NOW);
    const many = scoreCandidate(c({ title: "무관", body: "배포 ".repeat(200) }), "배포", NOW);
    expect(many).toBeGreaterThan(few);
    expect(many - few).toBeLessThan(150); // 선형이었으면 훨씬 벌어진다
  });

  it("매칭이 없으면 0", () => {
    expect(scoreCandidate(c({ title: "가", body: "나" }), "없는말", NOW)).toBe(0);
  });

  it("빈 질의는 0", () => {
    expect(scoreCandidate(c(), "  ", NOW)).toBe(0);
  });

  it("대소문자를 무시한다", () => {
    expect(scoreCandidate(c({ title: "BlockNote" }), "blocknote", NOW)).toBeGreaterThan(0);
  });
});

describe("scoreCandidate — 최근 가산", () => {
  it("같은 관련도면 최근 것이 위", () => {
    const recent = scoreCandidate(c({ title: "야간 배포", updatedAt: "2026-08-07T00:00:00Z" }), "배포", NOW);
    const old = scoreCandidate(c({ title: "야간 배포", updatedAt: "2025-01-01T00:00:00Z" }), "배포", NOW);
    expect(recent).toBeGreaterThan(old);
  });

  it("최근 가산이 관련도를 뒤집을 만큼 크지는 않다", () => {
    const oldExact = scoreCandidate(c({ title: "배포", updatedAt: "2020-01-01T00:00:00Z" }), "배포", NOW);
    const newLoose = scoreCandidate(c({ title: "야간 배포 절차", updatedAt: "2026-08-08T00:00:00Z" }), "배포", NOW);
    expect(oldExact).toBeGreaterThan(newLoose);
  });

  it("수정 시각을 몰라도 터지지 않는다", () => {
    expect(scoreCandidate(c({ updatedAt: null, title: "배포" }), "배포", NOW)).toBeGreaterThan(0);
  });
});

describe("passesFilters", () => {
  it("프로젝트로 좁힌다", () => {
    expect(passesFilters(c({ projectId: "p1" }), { projectId: "p1" })).toBe(true);
    expect(passesFilters(c({ projectId: "p2" }), { projectId: "p1" })).toBe(false);
  });

  it("__none__ 은 미분류만", () => {
    expect(passesFilters(c({ projectId: null }), { projectId: "__none__" })).toBe(true);
    expect(passesFilters(c({ projectId: "p1" }), { projectId: "__none__" })).toBe(false);
  });

  it("종류로 좁힌다", () => {
    expect(passesFilters(c({ kind: "doc" }), { kinds: ["doc"] })).toBe(true);
    expect(passesFilters(c({ kind: "decision" }), { kinds: ["doc"] })).toBe(false);
    expect(passesFilters(c({ kind: "decision" }), { kinds: [] })).toBe(true); // 빈 배열 = 전체
  });

  it("기간으로 좁힌다", () => {
    const item = c({ updatedAt: "2026-08-05T12:00:00Z" });
    expect(passesFilters(item, { from: "2026-08-01" })).toBe(true);
    expect(passesFilters(item, { from: "2026-08-06" })).toBe(false);
    expect(passesFilters(item, { to: "2026-08-06" })).toBe(true);
    expect(passesFilters(item, { to: "2026-08-04" })).toBe(false);
  });

  it("to 는 그날 끝까지 포함한다 — 날짜만 주면 하루가 통째로 빠지면 안 된다", () => {
    expect(passesFilters(c({ updatedAt: "2026-08-06T23:30:00Z" }), { to: "2026-08-06" })).toBe(true);
  });

  it("시각을 모르는 항목은 기간 필터에서 빠진다", () => {
    expect(passesFilters(c({ updatedAt: null }), { from: "2026-08-01" })).toBe(false);
    expect(passesFilters(c({ updatedAt: null }), {})).toBe(true); // 기간 안 걸면 통과
  });
});

describe("rankSearch", () => {
  const items: Candidate[] = [
    c({ id: "a", title: "야간 배포 절차", body: "본문", updatedAt: "2026-01-01T00:00:00Z" }),
    c({ id: "b", title: "배포", body: "본문", updatedAt: "2026-01-01T00:00:00Z" }),
    c({ id: "d", title: "무관", body: "배포 얘기가 한 번", updatedAt: "2026-01-01T00:00:00Z" }),
    c({ id: "e", title: "전혀 다름", body: "관련 없음", updatedAt: "2026-01-01T00:00:00Z" }),
  ];

  it("점수 순으로 나오고 매칭 없는 건 빠진다", () => {
    const r = rankSearch(items, "배포", {}, 30, NOW);
    expect(r.map((x) => x.id)).toEqual(["b", "a", "d"]);
  });

  it("스니펫이 붙는다", () => {
    expect(rankSearch(items, "배포", {}, 30, NOW).find((x) => x.id === "d")!.snippet).toContain("배포");
  });

  it("필터가 랭킹보다 먼저 걸린다", () => {
    const r = rankSearch(items.map((x) => ({ ...x, projectId: x.id === "b" ? "p1" : "p2" })), "배포", { projectId: "p1" }, 30, NOW);
    expect(r.map((x) => x.id)).toEqual(["b"]);
  });

  it("limit 을 지킨다", () => {
    expect(rankSearch(items, "배포", {}, 1, NOW)).toHaveLength(1);
  });

  it("동점이면 매번 같은 순서", () => {
    const same = [c({ id: "x", title: "배포" }), c({ id: "y", title: "배포" })];
    const a = rankSearch(same, "배포", {}, 30, NOW).map((r) => r.id);
    const b = rankSearch([...same].reverse(), "배포", {}, 30, NOW).map((r) => r.id);
    expect(a).toEqual(b);
  });

  it("빈 질의는 결과가 없다(전체 목록을 검색 결과로 내지 않는다)", () => {
    expect(rankSearch(items, "", {}, 30, NOW)).toEqual([]);
  });
});

describe("makeSnippet", () => {
  it("짧으면 그대로", () => {
    expect(makeSnippet("짧은 본문", "본문")).toBe("짧은 본문");
  });
  it("매칭 주변을 잘라 준다", () => {
    const long = "가".repeat(200) + "배포" + "나".repeat(200);
    const s = makeSnippet(long, "배포");
    expect(s).toContain("배포");
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
  });
  it("매칭이 없으면 앞부분", () => {
    expect(makeSnippet("가".repeat(300), "없음").startsWith("가")).toBe(true);
  });
});

describe("usesTrigramIndex", () => {
  it("3글자 이상이어야 인덱스가 붙는다 — 한계를 코드가 알고 있어야 한다", () => {
    expect(usesTrigramIndex("배포")).toBe(false);
    expect(usesTrigramIndex("에디터")).toBe(true);
    expect(usesTrigramIndex("  ab  ")).toBe(false);
  });
});
