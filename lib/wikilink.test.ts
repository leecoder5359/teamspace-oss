import { describe, it, expect } from "vitest";
import { extractWikiTitles, computeBacklinks, computeGraph, computeLint, graphToCypher } from "@/lib/wikilink";

describe("extractWikiTitles", () => {
  it("[[제목]] 들을 추출(트림·중복제거·순서유지)", () => {
    expect(extractWikiTitles("앞 [[Foo]] 중간 [[ Bar ]] 끝 [[Foo]]")).toEqual(["Foo", "Bar"]);
  });
  it("[[제목|표시]] 는 제목부만", () => {
    expect(extractWikiTitles("[[PLAN|계획 문서]]")).toEqual(["PLAN"]);
  });
  it("링크 없으면 빈 배열", () => {
    expect(extractWikiTitles("그냥 텍스트")).toEqual([]);
  });
});

describe("computeBacklinks", () => {
  const pages = [
    { id: "a", title: "Alpha", markdown: "see [[Beta]] and [[Gamma]]" },
    { id: "b", title: "Beta", markdown: "back to [[Alpha]]" },
    { id: "c", title: "Gamma", markdown: "no links" },
    { id: "d", title: "Delta", markdown: "[[beta]] 대소문자 무시" },
  ];
  const back = computeBacklinks(pages);

  it("타깃별 역링크 소스 매핑(대소문자 무시)", () => {
    expect(back["b"].map((s) => s.id).sort()).toEqual(["a", "d"]);
    expect(back["a"].map((s) => s.id)).toEqual(["b"]);
    expect(back["c"].map((s) => s.id)).toEqual(["a"]);
  });
  it("링크 안 받는 페이지는 키 없음/빈", () => {
    expect(back["d"] ?? []).toEqual([]);
  });
  it("자기 링크는 제외", () => {
    const b = computeBacklinks([{ id: "x", title: "X", markdown: "[[X]] 자기참조" }]);
    expect(b["x"] ?? []).toEqual([]);
  });
});

describe("computeGraph", () => {
  const pages = [
    { id: "a", title: "Alpha", markdown: "[[Beta]] [[없음]]" },
    { id: "b", title: "Beta", markdown: "[[Alpha]]" },
    { id: "c", title: "Gamma", markdown: "" },
  ];
  const g = computeGraph(pages);

  it("노드는 모든 페이지", () => {
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
  });
  it("간선은 해결된 위키링크만(미해결·자기 제외, 중복제거)", () => {
    expect(g.edges).toContainEqual({ from: "a", to: "b" });
    expect(g.edges).toContainEqual({ from: "b", to: "a" });
    expect(g.edges).toHaveLength(2);
  });
});

describe("computeLint", () => {
  const pages = [
    { id: "a", title: "Alpha", markdown: "[[Beta]] [[Ghost]]" },
    { id: "b", title: "Beta", markdown: "[[Alpha]]" },
    { id: "c", title: "Gamma", markdown: "링크 없음(고아)" },
  ];
  const lint = computeLint(pages);

  it("깨진 링크: 해결 안 되는 [[대상]]", () => {
    expect(lint.broken).toEqual([{ sourceId: "a", sourceTitle: "Alpha", target: "Ghost" }]);
  });
  it("고아: 인/아웃 링크 모두 없는 문서", () => {
    expect(lint.orphans.map((o) => o.id)).toEqual(["c"]);
  });
});

describe("graphToCypher", () => {
  const cy = graphToCypher({
    nodes: [{ id: "a", title: "Al'pha" }],
    edges: [{ from: "a", to: "b" }],
  });
  it("노드 CREATE + 작은따옴표 이스케이프", () => {
    expect(cy).toContain("CREATE (`a`:Doc {id:'a', title:'Al\\'pha'})");
  });
  it("간선 MATCH+CREATE LINKS_TO", () => {
    expect(cy).toContain("MATCH (a:Doc {id:'a'}), (b:Doc {id:'b'}) CREATE (a)-[:LINKS_TO]->(b);");
  });
});
