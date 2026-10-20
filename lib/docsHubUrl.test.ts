import { describe, it, expect } from "vitest";
import { docsHubHref, parseDocsHubParams } from "./docsHubUrl";

const CATS = ["mddocs", "decisions", "risks"];

describe("문서 허브 URL(?cat=&id=)", () => {
  it("기본 탭(문서)에 선택이 없으면 /docs 그대로", () => {
    expect(docsHubHref("mddocs", null)).toBe("/docs");
  });

  it("탭과 선택 id 를 쿼리로 싣는다", () => {
    expect(docsHubHref("decisions", null)).toBe("/docs?cat=decisions");
    expect(docsHubHref("decisions", "d 1")).toBe("/docs?cat=decisions&id=d+1");
    expect(docsHubHref("mddocs", "p1")).toBe("/docs?cat=mddocs&id=p1");
  });

  it("searchParams 를 읽는다 — 모르는 탭은 기본 탭, 배열이면 첫 값", () => {
    expect(parseDocsHubParams({ cat: "decisions", id: "d1" }, CATS)).toEqual({ cat: "decisions", id: "d1" });
    expect(parseDocsHubParams({ cat: ["risks", "x"] }, CATS)).toEqual({ cat: "risks", id: null });
    expect(parseDocsHubParams({ cat: "nope", id: "d1" }, CATS)).toEqual({ cat: "mddocs", id: "d1" });
    expect(parseDocsHubParams({}, CATS)).toEqual({ cat: "mddocs", id: null });
  });

  it("왕복 — href 로 만든 쿼리를 다시 읽으면 같은 값", () => {
    const sp = new URLSearchParams(docsHubHref("decisions", "d1").split("?")[1]);
    expect(parseDocsHubParams(Object.fromEntries(sp), CATS)).toEqual({ cat: "decisions", id: "d1" });
  });
});
