import { describe, it, expect } from "vitest";
import { parseMarkdown, parseInline } from "@/lib/md/parse";
import { inlineText, collectTags, collectLinks } from "@/lib/md/ast";
import type { Block } from "@/lib/md/ast";

const t = (v: string) => ({ t: "text" as const, v });

/* ───────────────────────── 인라인 ───────────────────────── */

describe("parseInline — 기본 서식", () => {
  it("굵게", () => {
    expect(parseInline("앞 **굵게** 뒤")).toEqual([t("앞 "), { t: "strong", c: [t("굵게")] }, t(" 뒤")]);
  });

  it("이탤릭 — * 와 _ 양쪽", () => {
    expect(parseInline("*기울임*")).toEqual([{ t: "em", c: [t("기울임")] }]);
    expect(parseInline("_기울임_")).toEqual([{ t: "em", c: [t("기울임")] }]);
  });

  it("취소선", () => {
    expect(parseInline("~~폐기~~")).toEqual([{ t: "del", c: [t("폐기")] }]);
  });

  it("하이라이트", () => {
    expect(parseInline("==중요==")).toEqual([{ t: "mark", c: [t("중요")] }]);
  });

  it("인라인 코드 — 내부는 원문 보존", () => {
    expect(parseInline("`**안굵음**`")).toEqual([{ t: "code", v: "**안굵음**" }]);
  });

  it("굵게 안의 이탤릭 — 중첩", () => {
    expect(parseInline("**굵고 *기운* 것**")).toEqual([
      { t: "strong", c: [t("굵고 "), { t: "em", c: [t("기운")] }, t(" 것")] },
    ]);
  });

  it("snake_case 는 이탤릭이 아니다", () => {
    expect(parseInline("some_var_name")).toEqual([t("some_var_name")]);
  });

  it("짝이 없는 기호는 그냥 글자", () => {
    expect(parseInline("2 * 3 * 4 = 24")).toEqual([t("2 * 3 * 4 = 24")]);
  });
});

describe("parseInline — 링크·이미지 (A2·A3)", () => {
  it("표준 링크", () => {
    expect(parseInline("[문서](https://x.dev/a)")).toEqual([
      { t: "link", href: "https://x.dev/a", c: [t("문서")] },
    ]);
  });

  it("링크 라벨 안의 서식", () => {
    expect(parseInline("[**굵은** 링크](/p/1)")).toEqual([
      { t: "link", href: "/p/1", c: [{ t: "strong", c: [t("굵은")] }, t(" 링크")] },
    ]);
  });

  it("이미지 — 업로드 API 가 돌려주는 형태", () => {
    expect(parseInline("![스크린샷](/uploads/ws1/a1b2-shot.png)")).toEqual([
      { t: "image", src: "/uploads/ws1/a1b2-shot.png", alt: "스크린샷" },
    ]);
  });

  it("이미지와 링크가 헷갈리지 않는다", () => {
    expect(parseInline("![img](/a.png) 와 [link](/b)")).toEqual([
      { t: "image", src: "/a.png", alt: "img" },
      t(" 와 "),
      { t: "link", href: "/b", c: [t("link")] },
    ]);
  });

  it("코드 안의 링크 문법은 해석하지 않는다", () => {
    expect(parseInline("`[a](b)`")).toEqual([{ t: "code", v: "[a](b)" }]);
  });
});

describe("parseInline — 위키링크·태그", () => {
  it("[[제목]]", () => {
    expect(parseInline("[[설계 문서]]")).toEqual([{ t: "wikilink", target: "설계 문서", label: "설계 문서" }]);
  });

  it("[[제목|표시]]", () => {
    expect(parseInline("[[PLAN|계획]]")).toEqual([{ t: "wikilink", target: "PLAN", label: "계획" }]);
  });

  it("위키링크가 표준 링크보다 먼저 잡힌다", () => {
    expect(parseInline("[[A]]")).toEqual([{ t: "wikilink", target: "A", label: "A" }]);
  });

  it("#태그", () => {
    expect(parseInline("이건 #결정 이다")).toEqual([t("이건 "), { t: "tag", name: "결정" }, t(" 이다")]);
  });

  it("문장 중간의 # 는 태그가 아니다", () => {
    expect(parseInline("이슈 번호 A#12 참고")).toEqual([t("이슈 번호 A#12 참고")]);
  });

  it("코드 안의 #는 태그가 아니다", () => {
    expect(parseInline("`#!/bin/sh`")).toEqual([{ t: "code", v: "#!/bin/sh" }]);
  });
});

/* ───────────────────────── 블록 ───────────────────────── */

describe("parseMarkdown — 헤딩 (A4)", () => {
  it("h1~h6 전부, 그리고 제목 안 서식이 해석된다", () => {
    const doc = parseMarkdown("# **굵은** 제목\n\n###### 작은 [[링크]]");
    expect(doc.blocks[0]).toEqual({ t: "heading", level: 1, c: [{ t: "strong", c: [t("굵은")] }, t(" 제목")] });
    expect(doc.blocks[1]).toEqual({
      t: "heading",
      level: 6,
      c: [t("작은 "), { t: "wikilink", target: "링크", label: "링크" }],
    });
  });

  it("# 뒤에 공백이 없으면 헤딩이 아니다", () => {
    expect(parseMarkdown("#태그만있는줄").blocks[0].t).toBe("para");
  });
});

describe("parseMarkdown — 리스트 (A5)", () => {
  it("중첩 리스트가 계층을 보존한다", () => {
    const doc = parseMarkdown(["- 상위", "  - 하위", "    - 더하위", "- 상위2"].join("\n"));
    const list = doc.blocks[0];
    if (list.t !== "list") throw new Error("list 여야 함");
    expect(list.items).toHaveLength(2);
    expect(inlineText(list.items[0].c)).toBe("상위");

    const sub = list.items[0].children[0];
    if (sub.t !== "list") throw new Error("중첩 list 여야 함");
    expect(inlineText(sub.items[0].c)).toBe("하위");

    const subsub = sub.items[0].children[0];
    if (subsub.t !== "list") throw new Error("2단 중첩 list 여야 함");
    expect(inlineText(subsub.items[0].c)).toBe("더하위");
  });

  it("번호 리스트는 시작 번호를 기억한다", () => {
    const doc = parseMarkdown("3. 셋\n4. 넷");
    const list = doc.blocks[0];
    if (list.t !== "list") throw new Error("list");
    expect(list.ordered).toBe(true);
    expect(list.start).toBe(3);
  });

  it("체크박스 항목", () => {
    const doc = parseMarkdown("- [ ] 안함\n- [x] 함");
    const list = doc.blocks[0];
    if (list.t !== "list") throw new Error("list");
    expect(list.items.map((i) => i.checked)).toEqual([false, true]);
    expect(inlineText(list.items[1].c)).toBe("함");
  });

  it("번호/불릿이 섞이면 리스트가 갈린다", () => {
    const doc = parseMarkdown("- 불릿\n\n1. 번호");
    expect(doc.blocks.map((b) => b.t)).toEqual(["list", "list"]);
  });
});

describe("parseMarkdown — 인용·콜아웃", () => {
  it("여러 줄 인용이 한 블록으로 묶인다", () => {
    const doc = parseMarkdown("> 첫 줄\n> 둘째 줄");
    const q = doc.blocks[0];
    if (q.t !== "quote") throw new Error("quote");
    expect(q.c).toHaveLength(1);
    expect(inlineText((q.c[0] as Extract<Block, { t: "para" }>).c)).toBe("첫 줄 둘째 줄");
  });

  it("인용 안에 리스트가 들어간다", () => {
    const doc = parseMarkdown("> - 하나\n> - 둘");
    const q = doc.blocks[0];
    if (q.t !== "quote") throw new Error("quote");
    expect(q.c[0].t).toBe("list");
  });

  it("콜아웃 — > [!NOTE] 제목", () => {
    const doc = parseMarkdown("> [!WARNING] 주의\n> 본문이다");
    const c = doc.blocks[0];
    if (c.t !== "callout") throw new Error("callout");
    expect(c.kind).toBe("WARNING");
    expect(inlineText(c.title ?? [])).toBe("주의");
    expect(inlineText((c.c[0] as Extract<Block, { t: "para" }>).c)).toBe("본문이다");
  });

  it("제목 없는 콜아웃", () => {
    const doc = parseMarkdown("> [!NOTE]\n> 그냥 메모");
    const c = doc.blocks[0];
    if (c.t !== "callout") throw new Error("callout");
    expect(c.title).toBeNull();
  });
});

describe("parseMarkdown — 코드·표·구분선", () => {
  it("코드펜스는 언어를 기억하고 내부를 원문 보존한다", () => {
    const doc = parseMarkdown("```ts\nconst a = 1; // **not bold**\n```");
    expect(doc.blocks[0]).toEqual({ t: "code", lang: "ts", v: "const a = 1; // **not bold**" });
  });

  it("언어 없는 코드펜스", () => {
    expect(parseMarkdown("```\nplain\n```").blocks[0]).toEqual({ t: "code", lang: null, v: "plain" });
  });

  it("닫히지 않은 코드펜스도 블록으로 끝낸다", () => {
    expect(parseMarkdown("```\nabc").blocks[0]).toEqual({ t: "code", lang: null, v: "abc" });
  });

  it("표 — 정렬과 셀 서식", () => {
    const doc = parseMarkdown(["| 이름 | 값 |", "|:--|--:|", "| **A** | 1 |"].join("\n"));
    const tb = doc.blocks[0];
    if (tb.t !== "table") throw new Error("table");
    expect(tb.align).toEqual(["left", "right"]);
    expect(inlineText(tb.head[0].c)).toBe("이름");
    expect(tb.rows[0][0].c).toEqual([{ t: "strong", c: [t("A")] }]);
  });

  it("구분선", () => {
    expect(parseMarkdown("---").blocks[0]).toEqual({ t: "hr" });
  });
});

describe("parseMarkdown — 트랜스클루전·프론트매터", () => {
  it("![[문서]] 는 임베드 블록", () => {
    expect(parseMarkdown("![[설계 노트]]").blocks[0]).toEqual({ t: "embed", target: "설계 노트" });
  });

  it("YAML 프론트매터 — 스칼라와 배열", () => {
    const doc = parseMarkdown(["---", "title: 로요", "aliases: [LOYO, 단골노트]", "---", "", "본문"].join("\n"));
    expect(doc.frontmatter).toEqual({ title: "로요", aliases: ["LOYO", "단골노트"] });
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].t).toBe("para");
  });

  it("프론트매터 대시 리스트 형식", () => {
    const doc = parseMarkdown(["---", "aliases:", "  - A", "  - B", "---", "x"].join("\n"));
    expect(doc.frontmatter).toEqual({ aliases: ["A", "B"] });
  });

  it("프론트매터가 없으면 null", () => {
    expect(parseMarkdown("본문").frontmatter).toBeNull();
  });

  it("중간의 --- 는 프론트매터가 아니라 구분선", () => {
    const doc = parseMarkdown("본문\n\n---\n\n다음");
    expect(doc.frontmatter).toBeNull();
    expect(doc.blocks.map((b) => b.t)).toEqual(["para", "hr", "para"]);
  });
});

/* ───────────────────────── 수집 헬퍼 ───────────────────────── */

describe("collectTags / collectLinks", () => {
  it("중첩 구조 안의 태그·링크까지 모은다", () => {
    const doc = parseMarkdown(
      ["# 제목 #결정", "", "> 인용 [[A]]", "", "- 항목 #결정 #리스크", "  - 하위 [[B|비]]", "", "![[C]]"].join("\n"),
    );
    expect(collectTags(doc.blocks)).toEqual(["결정", "리스크"]);
    expect(collectLinks(doc.blocks)).toEqual([
      { target: "A", embed: false },
      { target: "B", embed: false },
      { target: "C", embed: true },
    ]);
  });
});
