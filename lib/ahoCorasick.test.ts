import { describe, it, expect } from "vitest";
import { buildMatcher } from "./ahoCorasick";

const found = (patterns: string[], text: string) => [...buildMatcher(patterns)(text)].sort((a, b) => a - b);
const naive = (patterns: string[], text: string) => patterns.flatMap((p, i) => (text.includes(p) ? [i] : []));

describe("buildMatcher (Aho–Corasick)", () => {
  it("겹치는 패턴을 모두 찾는다", () => {
    expect(found(["abcd", "bcde", "cd"], "xabcdex")).toEqual([0, 1, 2]);
  });
  it("다른 패턴의 접미사인 패턴도 찾는다", () => {
    expect(found(["she", "he", "hers"], "ushers")).toEqual([0, 1, 2]);
    expect(found(["배포 가이드 상세", "가이드 상세"], "이건 배포 가이드 상세다")).toEqual([0, 1]);
  });
  it("한글·중첩 제목", () => {
    expect(found(["배포 가이드", "배포 가이드 상세", "운영 수칙"], "…배포 가이드 상세 참고")).toEqual([0, 1]);
  });
  it("일치 없음", () => {
    expect(found(["배포 가이드", "abc"], "전혀 다른 본문 ab")).toEqual([]);
    expect(found([], "anything")).toEqual([]);
    expect(found(["abc"], "")).toEqual([]);
  });
  it("중복 패턴은 각 인덱스 모두 보고", () => {
    expect(found(["ab", "ab"], "xab")).toEqual([0, 1]);
  });
  it("무작위 대조: includes 와 동일", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const alpha = "ab가나 ";
    const str = (n: number) => Array.from({ length: n }, () => alpha[Math.floor(rnd() * alpha.length)]).join("");
    for (let k = 0; k < 200; k++) {
      const patterns = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => str(1 + Math.floor(rnd() * 4)));
      const text = str(Math.floor(rnd() * 40));
      expect(found(patterns, text)).toEqual(naive(patterns, text));
    }
  });
});
