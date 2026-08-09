import { describe, it, expect } from "vitest";
import { buildIndex, cosine, similarTo, searchVectors, vectorize } from "@/lib/vector";

const DOCS = [
  { id: "a", title: "배포 자동화", text: "맥미니에서 launchd 로 배포를 자동화한다. 빌드 후 재기동." },
  { id: "b", title: "배포 롤백", text: "배포가 잘못되면 이전 빌드로 되돌린다. launchd 재기동." },
  { id: "c", title: "고객 문자 발송", text: "예약 확정 문자를 알림톡으로 보낸다. 발송 실패는 재시도." },
  { id: "d", title: "문자 템플릿", text: "알림톡 템플릿을 등록하고 검수를 받는다. 문자 발송 문구." },
];

describe("vectorize", () => {
  it("같은 글이면 같은 벡터", () => {
    expect(vectorize("배포 자동화")).toEqual(vectorize("배포 자동화"));
  });

  it("빈 글은 빈 벡터", () => {
    expect(vectorize("").size).toBe(0);
    expect(vectorize("   ").size).toBe(0);
  });

  it("어순이 달라도 같은 벡터(가방 모형)", () => {
    expect(vectorize("배포 자동화")).toEqual(vectorize("자동화 배포"));
  });
});

describe("cosine", () => {
  it("같은 벡터는 1", () => {
    const v = vectorize("배포 자동화 launchd");
    expect(cosine(v, v)).toBeCloseTo(1, 6);
  });

  it("겹치는 낱말이 없으면 0", () => {
    expect(cosine(vectorize("배포 빌드"), vectorize("고객 문자"))).toBe(0);
  });

  it("빈 벡터는 0(0으로 나누지 않는다)", () => {
    expect(cosine(new Map(), vectorize("배포"))).toBe(0);
    expect(cosine(new Map(), new Map())).toBe(0);
  });

  it("0과 1 사이", () => {
    const s = cosine(vectorize("배포 자동화 빌드"), vectorize("배포 롤백 빌드"));
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});

describe("similarTo — 이 문서와 비슷한 문서", () => {
  const idx = buildIndex(DOCS);

  it("같은 주제끼리 묶인다", () => {
    const top = similarTo(idx, "a", 2).map((r) => r.id);
    expect(top[0]).toBe("b"); // 배포 ↔ 배포
    expect(top).not.toContain("a"); // 자기 자신은 빼고
  });

  it("문자 주제도 마찬가지", () => {
    expect(similarTo(idx, "c", 1)[0].id).toBe("d");
  });

  it("점수는 내림차순", () => {
    const r = similarTo(idx, "a", 3);
    for (let i = 1; i < r.length; i++) expect(r[i - 1].score).toBeGreaterThanOrEqual(r[i].score);
  });

  it("없는 문서는 빈 결과", () => {
    expect(similarTo(idx, "없음", 3)).toEqual([]);
  });

  it("겹치는 게 전혀 없으면 결과에서 뺀다(0점 문서를 억지로 채우지 않는다)", () => {
    const small = buildIndex([
      { id: "x", title: "배포", text: "배포 빌드" },
      { id: "y", title: "전혀 다른 것", text: "고양이 사료" },
    ]);
    expect(similarTo(small, "x", 5)).toEqual([]);
  });
});

describe("searchVectors — 질의로 찾기", () => {
  const idx = buildIndex(DOCS);

  it("질의어가 든 문서를 위로", () => {
    const r = searchVectors(idx, "배포 되돌리기 롤백", 2);
    expect(r[0].id).toBe("b");
  });

  it("흔한 낱말은 변별력이 낮다(IDF)", () => {
    // '재기동'은 a·b 둘 다에 있고 '롤백'은 b 에만 있다 → 롤백 질의가 b 를 더 세게 짚는다
    const byRare = searchVectors(idx, "롤백", 1);
    expect(byRare[0].id).toBe("b");
  });

  it("아무 것도 안 맞으면 빈 배열", () => {
    expect(searchVectors(idx, "존재하지않는낱말들", 5)).toEqual([]);
  });

  it("빈 질의는 빈 배열", () => {
    expect(searchVectors(idx, "   ", 5)).toEqual([]);
  });

  it("limit 을 지킨다", () => {
    expect(searchVectors(idx, "배포 문자 알림톡 launchd", 2)).toHaveLength(2);
  });
});

describe("buildIndex", () => {
  it("빈 목록도 다룬다", () => {
    const idx = buildIndex([]);
    expect(searchVectors(idx, "배포", 3)).toEqual([]);
    expect(similarTo(idx, "a", 3)).toEqual([]);
  });

  it("제목이 본문보다 무겁다", () => {
    const idx = buildIndex([
      { id: "t", title: "환불 정책", text: "관계없는 내용입니다." },
      { id: "u", title: "관계없는 제목", text: "환불 정책 환불 정책" },
    ]);
    // 제목에 있는 쪽이 먼저 — 제목은 사람이 고른 요약이다
    expect(searchVectors(idx, "환불 정책", 2)[0].id).toBe("t");
  });
});
