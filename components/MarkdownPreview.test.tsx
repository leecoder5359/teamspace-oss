// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import MarkdownPreview from "./MarkdownPreview";

afterEach(cleanup);

describe("MarkdownPreview 표·헤딩·코드펜스", () => {
  it("GFM 표를 <table> 로 렌더하고 파이프 원본이 새지 않는다", () => {
    const md = ["| A | B |", "|---|---|", "| 1 | 2 |"].join("\n");
    const { container } = render(<MarkdownPreview markdown={md} />);
    expect(container.querySelector("table")).not.toBeNull();
    const th = container.querySelectorAll("th");
    expect(th).toHaveLength(2);
    expect(th[0].textContent).toBe("A");
    const td = container.querySelectorAll("td");
    expect(td).toHaveLength(2);
    expect(td[0].textContent).toBe("1");
    expect(container.textContent).not.toContain("|---|");
  });

  it("구분선의 정렬(:--, :-:, --:)을 셀에 반영한다", () => {
    const md = ["| L | C | R |", "|:--|:-:|--:|", "| a | b | c |"].join("\n");
    const { container } = render(<MarkdownPreview markdown={md} />);
    const th = container.querySelectorAll("th");
    expect(th[0].style.textAlign).toBe("left");
    expect(th[1].style.textAlign).toBe("center");
    expect(th[2].style.textAlign).toBe("right");
  });

  it("h4 를 헤딩으로 렌더한다(#### 리터럴 아님)", () => {
    const { container } = render(<MarkdownPreview markdown={"#### 소제목"} />);
    // 끝의 '#' 은 hover 앵커(U5) — 헤딩 글자 자체는 첫 자식이다
    expect(container.querySelector("h4")?.firstChild?.textContent).toBe("소제목");
    expect(container.textContent).not.toContain("####");
  });

  it("헤딩마다 id 와 '#' 앵커 — 같은 제목은 -2, 인용 안 헤딩도 같은 순번", () => {
    const { container } = render(<MarkdownPreview markdown={"## 설치 방법\n\n> ## 설치 방법\n\n### 맥"} />);
    const hs = Array.from(container.querySelectorAll("h2,h3"));
    expect(hs.map((h) => h.id)).toEqual(["설치-방법", "설치-방법-2", "맥"]);
    const anchor = hs[1].querySelector("a.ws-heading-anchor");
    expect(anchor?.getAttribute("href")).toBe("#설치-방법-2");
    expect(anchor?.getAttribute("aria-label")).toBe("이 절 링크");
    expect(hs[1].lastElementChild).toBe(anchor);
  });

  it("headingIds={false} 면 헤딩에 id·'#' 앵커를 붙이지 않는다(임베드용)", () => {
    const { container } = render(<MarkdownPreview markdown={"## 개요\n\n### 맥"} headingIds={false} />);
    const hs = Array.from(container.querySelectorAll("h2,h3"));
    expect(hs.map((h) => h.textContent)).toEqual(["개요", "맥"]);
    expect(hs.map((h) => h.hasAttribute("id"))).toEqual([false, false]);
    expect(container.querySelector("a.ws-heading-anchor")).toBeNull();
  });

  it("코드펜스 안의 내용을 원본 그대로 보존한다", () => {
    const md = ["```", "const x = |not a table|;", "```"].join("\n");
    const { container } = render(<MarkdownPreview markdown={md} />);
    expect(container.querySelector("pre code")?.textContent).toBe("const x = |not a table|;");
    expect(container.querySelector("table")).toBeNull();
  });

  it("구분선 없는 단독 파이프 줄은 표로 취급하지 않는다", () => {
    const { container } = render(<MarkdownPreview markdown={"| 그냥 텍스트 |"} />);
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).toContain("| 그냥 텍스트 |");
  });
});

/* ───────── 격차조사 A2·A3·A4·A5·A6 회귀 방지 ───────── */

describe("MarkdownPreview 이미지·링크 (A2·A3)", () => {
  it("이미지를 <img> 로 렌더한다 — /api/upload 가 돌려주는 형태", () => {
    const { container } = render(<MarkdownPreview markdown={"![샷](/uploads/w1/a1b2-shot.png)"} />);
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/uploads/w1/a1b2-shot.png");
    expect(img?.getAttribute("alt")).toBe("샷");
    expect(container.textContent).not.toContain("![");
  });

  it("표준 링크를 <a href> 로 렌더한다", () => {
    const { container } = render(<MarkdownPreview markdown={"[문서](https://x.dev/a)"} />);
    const a = container.querySelector("a");
    expect(a?.getAttribute("href")).toBe("https://x.dev/a");
    expect(a?.textContent).toBe("문서");
    expect(container.textContent).not.toContain("](");
  });

  it("외부 링크엔 rel=noopener 를 붙인다", () => {
    const { container } = render(<MarkdownPreview markdown={"[x](https://evil.example/a)"} />);
    const a = container.querySelector("a");
    expect(a?.getAttribute("target")).toBe("_blank");
    expect(a?.getAttribute("rel")).toContain("noopener");
  });

  it("javascript: 링크는 href 를 비운다", () => {
    const { container } = render(<MarkdownPreview markdown={"[x](javascript:alert(1))"} />);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("");
  });
});

describe("MarkdownPreview 제목 안 서식 (A4)", () => {
  it("h1~h3 에서도 굵게·코드·위키링크가 해석된다", () => {
    const { container } = render(
      <MarkdownPreview markdown={"# **굵은** 제목"} resolveLink={() => "/p/1"} />,
    );
    expect(container.querySelector("h1 strong")?.textContent).toBe("굵은");
    expect(container.textContent).not.toContain("**");
  });

  it("h2 안의 위키링크도 링크가 된다", () => {
    const { container } = render(<MarkdownPreview markdown={"## [[대상]]"} resolveLink={() => "/p/9"} />);
    expect(container.querySelector("h2 a")?.getAttribute("href")).toBe("/p/9");
  });
});

describe("MarkdownPreview 중첩 리스트 (A5)", () => {
  it("들여쓴 항목이 중첩 <ul> 로 나온다", () => {
    const md = ["- 상위", "  - 하위"].join("\n");
    const { container } = render(<MarkdownPreview markdown={md} />);
    expect(container.querySelector("ul li ul li")?.textContent).toContain("하위");
  });

  it("번호 리스트는 <ol> 이고 시작 번호를 반영한다", () => {
    const { container } = render(<MarkdownPreview markdown={"3. 셋\n4. 넷"} />);
    expect(container.querySelector("ol")?.getAttribute("start")).toBe("3");
  });
});

describe("MarkdownPreview 강조 (A6)", () => {
  it("이탤릭·취소선·하이라이트", () => {
    const { container } = render(<MarkdownPreview markdown={"*기울임* ~~취소~~ ==강조=="} />);
    expect(container.querySelector("em")?.textContent).toBe("기울임");
    expect(container.querySelector("del")?.textContent).toBe("취소");
    expect(container.querySelector("mark")?.textContent).toBe("강조");
    expect(container.textContent).not.toContain("~~");
  });
});

describe("MarkdownPreview 위키링크·태그·콜아웃", () => {
  it("미해결 위키링크는 링크가 아니고, onCreateLink 가 있으면 생성 버튼이 된다", () => {
    const { container } = render(<MarkdownPreview markdown={"[[없는문서]]"} onCreateLink={() => {}} />);
    expect(container.querySelector("a")).toBeNull();
    const btn = container.querySelector("button");
    expect(btn?.textContent).toContain("없는문서");
    expect(btn?.getAttribute("title")).toContain("만들기");
  });

  it("#태그를 칩으로 렌더한다", () => {
    const { container } = render(<MarkdownPreview markdown={"메모 #결정 끝"} />);
    const tag = container.querySelector("[data-tag]");
    expect(tag?.getAttribute("data-tag")).toBe("결정");
    expect(tag?.textContent).toBe("#결정");
  });

  it("콜아웃은 종류 라벨과 본문을 함께 렌더한다", () => {
    const { container } = render(<MarkdownPreview markdown={"> [!WARNING] 주의\n> 본문"} />);
    expect(container.textContent).toContain("주의");
    expect(container.textContent).toContain("본문");
    expect(container.textContent).not.toContain("[!WARNING]");
  });

  it("임베드는 renderEmbed 로 위임한다", () => {
    const { container } = render(
      <MarkdownPreview markdown={"![[다른 노트]]"} renderEmbed={(t) => <i>embed:{t}</i>} />,
    );
    expect(container.querySelector("i")?.textContent).toBe("embed:다른 노트");
  });
});
