import { describe, it, expect } from "vitest";
import { slugifyHeading, uniqueIds, extractToc, buildTocFromDom, headingIdMap } from "@/lib/md/headings";
import { parseMarkdown } from "@/lib/md/parse";

describe("slugifyHeading", () => {
  it("한글은 그대로 두고 공백은 '-'", () => {
    expect(slugifyHeading("  설치 방법 ")).toBe("설치-방법");
  });

  it("소문자화·영숫자 외 제거·연속 '-' 축약", () => {
    expect(slugifyHeading("Hello, World! — API v2")).toBe("hello-world-api-v2");
    expect(slugifyHeading("snake_case 와 kebab-case")).toBe("snake_case-와-kebab-case");
  });

  it("남는 게 없으면 section", () => {
    expect(slugifyHeading("!!! ???")).toBe("section");
    expect(slugifyHeading("")).toBe("section");
  });
});

describe("uniqueIds", () => {
  it("중복은 -2, -3 …", () => {
    expect(uniqueIds(["a", "b", "a", "a"])).toEqual(["a", "b", "a-2", "a-3"]);
  });

  it("접미사가 이미 있는 슬러그와 겹치지 않는다", () => {
    expect(uniqueIds(["a-2", "a", "a"])).toEqual(["a-2", "a", "a-3"]);
  });
});

describe("extractToc", () => {
  it("h1~h3 만, 등장순, 한글 슬러그", () => {
    const md = "# 개요\n\n본문\n\n## 설치\n\n### 맥\n\n#### 너무 깊음\n";
    expect(extractToc(md)).toEqual([
      { level: 1, text: "개요", id: "개요" },
      { level: 2, text: "설치", id: "설치" },
      { level: 3, text: "맥", id: "맥" },
    ]);
  });

  it("같은 제목은 -2 접미사", () => {
    const ids = extractToc("## 예시\n\n## 예시\n\n## 예시\n").map((t) => t.id);
    expect(ids).toEqual(["예시", "예시-2", "예시-3"]);
  });

  it("코드펜스 안의 # 은 헤딩이 아니다", () => {
    const md = "# 진짜\n\n```bash\n# 주석\n## 이것도\n```\n\n## 둘째\n";
    expect(extractToc(md).map((t) => t.text)).toEqual(["진짜", "둘째"]);
  });

  it("링크·강조·코드는 평문으로", () => {
    const md = "## [문서](https://example.com) 의 **굵은** `코드` 부분\n";
    expect(extractToc(md)).toEqual([{ level: 2, text: "문서 의 굵은 코드 부분", id: "문서-의-굵은-코드-부분" }]);
  });

  it("인용·콜아웃 안의 헤딩도 렌더 순서대로 잡는다", () => {
    const md = "# 위\n\n> ## 인용 안\n\n## 아래\n";
    expect(extractToc(md).map((t) => t.text)).toEqual(["위", "인용 안", "아래"]);
  });

  it("h4 이하와 겹치는 제목도 미리보기 id 와 같은 번호를 쓴다", () => {
    // 미리보기는 h1~h6 전부에 id 를 주므로 TOC 도 같은 순번 체계를 따라야 앵커가 맞는다
    const md = "#### 예시\n\n## 예시\n";
    expect(extractToc(md)).toEqual([{ level: 2, text: "예시", id: "예시-2" }]);
  });
});

describe("headingIdMap", () => {
  it("블록 객체마다 extractToc 와 같은 id", () => {
    const doc = parseMarkdown("## 하나\n\n> ## 하나\n");
    const map = headingIdMap(doc.blocks);
    const first = doc.blocks[0];
    const quote = doc.blocks[1];
    expect(map.get(first)).toBe("하나");
    if (quote.t !== "quote") throw new Error("quote 기대");
    expect(map.get(quote.c[0])).toBe("하나-2");
  });
});

describe("buildTocFromDom", () => {
  it("있는 id 는 유지, 없는 것엔 슬러그(기존 id 와 겹치지 않게)", () => {
    const out = buildTocFromDom([
      { level: 1, text: "개요", id: "개요" },
      { level: 2, text: "개요", id: null },
      { level: 2, text: "설치 방법", id: null },
      { level: 3, text: "설치 방법", id: "" },
    ]);
    expect(out).toEqual([
      { level: 1, text: "개요", id: "개요" },
      { level: 2, text: "개요", id: "개요-2" },
      { level: 2, text: "설치 방법", id: "설치-방법" },
      { level: 3, text: "설치 방법", id: "설치-방법-2" },
    ]);
  });

  it("텍스트는 trim, 레벨 4 이상은 버린다", () => {
    expect(buildTocFromDom([{ level: 4, text: "x", id: null }, { level: 2, text: "  y  ", id: null }])).toEqual([{ level: 2, text: "y", id: "y" }]);
  });
});
