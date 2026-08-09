import { describe, it, expect } from "vitest";
import { extractWikiTitles, computeBacklinks, computeGraph, computeLint, graphToCypher, buildTitleIndex } from "@/lib/wikilink";

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

/* ───────── B6: 프론트매터 별칭이 링크 해석에 반영된다 ───────── */

describe("buildTitleIndex — 별칭", () => {
  const pages = [
    { id: "loyo", title: "로요", markdown: "---\naliases: [LOYO, 단골노트]\n---\n\n본문" },
    { id: "plan", title: "계획", markdown: "우리는 [[LOYO]] 와 [[단골노트]] 와 [[로요]] 를 쓴다" },
  ];

  it("별칭으로도 같은 문서를 가리킨다", () => {
    const idx = buildTitleIndex(pages);
    expect(idx.get("loyo")).toBe("loyo");
    expect(idx.get("단골노트")).toBe("loyo");
    expect(idx.get("로요")).toBe("loyo");
  });

  it("별칭 링크가 백링크로 잡힌다 — 세 표기가 한 소스로 합쳐진다", () => {
    const back = computeBacklinks(pages);
    expect(back["loyo"]).toEqual([{ id: "plan", title: "계획" }]);
  });

  it("별칭 링크는 깨진 링크가 아니다", () => {
    expect(computeLint(pages).broken).toEqual([]);
  });

  it("실제 제목이 별칭보다 우선한다", () => {
    const conflict = [
      { id: "a", title: "공용", markdown: null },
      { id: "b", title: "다른문서", markdown: "---\naliases: [공용]\n---\n" },
    ];
    expect(buildTitleIndex(conflict).get("공용")).toBe("a");
  });

  it("임베드 ![[문서]] 도 그래프 간선이 된다", () => {
    const g = computeGraph([
      { id: "x", title: "X", markdown: "![[Y]]" },
      { id: "y", title: "Y", markdown: null },
    ]);
    expect(g.edges).toEqual([{ from: "x", to: "y" }]);
  });
});
