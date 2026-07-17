import { describe, it, expect } from "vitest";
import {
  tokenize,
  scorePassage,
  extractPassages,
  rankSources,
  buildExtractiveAnswer,
  type SourceDoc,
} from "./ask";

describe("tokenize", () => {
  it("소문자화·구두점 제거·불용어/짧은토큰 제거·중복 제거", () => {
    expect(tokenize("워커는 어떻게 동작하나요?")).toEqual(["워커는", "동작하나요"]);
    expect(tokenize("How does the WORKER work?")).toEqual(["does", "worker", "work"]);
    expect(tokenize("a an of to")).toEqual([]);
    expect(tokenize("redis redis redis")).toEqual(["redis"]);
  });

  it("빈/공백 질의는 빈 배열", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });
});

describe("scorePassage", () => {
  it("커버리지(서로 다른 질의어 비율)가 높을수록 높은 점수", () => {
    const terms = ["redis", "worker"];
    const both = scorePassage("redis 와 worker 를 함께 설명", terms);
    const one = scorePassage("redis 만 여러 번 redis redis", terms);
    expect(both).toBeGreaterThan(one);
  });

  it("매칭 없으면 0, 질의어 없으면 0", () => {
    expect(scorePassage("관련 없는 문장", ["redis"])).toBe(0);
    expect(scorePassage("아무 내용", [])).toBe(0);
  });
});

describe("extractPassages", () => {
  const md = `# 개요

이 문서는 워커를 설명한다.

## 디스패치

워커는 redis 없이 DB 폴링으로 만기 스케줄을 처리한다.

## 무관

전혀 다른 내용.`;

  it("헤딩 컨텍스트를 추적하고 점수순으로 상위 패시지를 반환", () => {
    const ps = extractPassages(md, ["워커", "redis"], 2);
    expect(ps.length).toBeGreaterThan(0);
    expect(ps[0].text).toContain("redis");
    expect(ps[0].heading).toBe("디스패치");
  });

  it("매칭 없으면 빈 배열", () => {
    expect(extractPassages(md, ["존재하지않는단어"], 2)).toEqual([]);
  });
});

describe("rankSources", () => {
  const cands: SourceDoc[] = [
    { id: "d1", title: "워커 가이드", kind: "doc", body: "# 워커\n\n워커는 redis 없이 DB 폴링으로 동작한다." },
    { id: "d2", title: "관련 없음", kind: "doc", body: "전혀 다른 내용." },
    { id: "dec1", title: "redis 결정", kind: "decision", body: "redis 대신 폴링을 쓰기로 했다." },
  ];

  it("점수순 정렬·매칭만·제목 보너스 반영", () => {
    const ranked = rankSources(cands, ["redis", "워커"], 5);
    const ids = ranked.map((r) => r.id);
    expect(ids).toContain("d1");
    expect(ids).not.toContain("d2");
    expect(ranked[0].id).toBe("d1"); // 제목+본문 모두 매칭 → 최상위
    expect(ranked[0].passage).toContain("redis");
  });

  it("topN 으로 제한", () => {
    const ranked = rankSources(cands, ["redis"], 1);
    expect(ranked.length).toBe(1);
  });
});

describe("buildExtractiveAnswer", () => {
  it("출처 없으면 안내 문구", () => {
    expect(buildExtractiveAnswer([])).toContain("찾지 못했습니다");
  });

  it("상위 출처를 인용 번호와 함께 묶는다", () => {
    const ranked = rankSources(
      [{ id: "d1", title: "워커", kind: "doc", body: "워커는 redis 없이 동작한다." }],
      ["redis"],
      5,
    );
    const ans = buildExtractiveAnswer(ranked);
    expect(ans).toContain("[1]");
    expect(ans).toContain("워커");
  });
});
