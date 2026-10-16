import { describe, it, expect } from "vitest";
import { takePrefetch, type PagePrefetch } from "./pagePrefetch";

const mk = (nonce: string): PagePrefetch => ({
  page: { id: "p", title: "t", icon: null, parentId: null, kind: "doc", rev: 3 },
  markdown: "x",
  nonce,
});

describe("takePrefetch — 서버 미리 읽기는 한 번만", () => {
  it("처음엔 돌려주고, 같은 nonce 는 다시 주지 않는다(모드 전환·뒤로 가기 재사용 차단)", () => {
    const p = mk("n1");
    expect(takePrefetch(p)).toBe(p);
    expect(takePrefetch(p)).toBeNull();
    expect(takePrefetch({ ...p })).toBeNull();
  });
  it("새 렌더(새 nonce)는 다시 쓴다 · 없으면 null", () => {
    expect(takePrefetch(mk("n2"))).not.toBeNull();
    expect(takePrefetch(null)).toBeNull();
    expect(takePrefetch(undefined)).toBeNull();
  });
});
