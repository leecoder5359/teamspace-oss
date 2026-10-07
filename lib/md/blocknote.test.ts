import { describe, it, expect } from "vitest";
import { parseMarkdown } from "@/lib/md/parse";
import { serializeMarkdown } from "@/lib/md/serialize";
import { astToBlocks, blocksToAst } from "@/lib/md/blocknote";
import type { BNBlock, BNInline } from "@/lib/md/blocknote";

/** md → AST → BlockNote → AST → md 가 고정점이어야 한다. */
function through(md: string): string {
  const doc = parseMarkdown(md);
  const blocks = astToBlocks(doc.blocks);
  const back = blocksToAst(blocks);
  return serializeMarkdown({ frontmatter: doc.frontmatter, blocks: back });
}
const stable = (md: string) => expect(through(md)).toBe(md);

const firstBlock = (md: string): BNBlock => astToBlocks(parseMarkdown(md).blocks)[0];

/* ───────────────────────── 블록 매핑 ───────────────────────── */

describe("astToBlocks — 블록 타입 매핑", () => {
  it("헤딩 → heading(level)", () => {
    const b = firstBlock("## 제목");
    expect(b.type).toBe("heading");
    expect(b.props?.level).toBe(2);
  });

  it("문단 → paragraph", () => {
    expect(firstBlock("본문").type).toBe("paragraph");
  });

  it("인용 → quote + children", () => {
    const b = firstBlock("> 인용");
    expect(b.type).toBe("quote");
  });

  it("코드펜스 → codeBlock(language)", () => {
    const b = firstBlock("```ts\nconst a=1\n```");
    expect(b.type).toBe("codeBlock");
    expect(b.props?.language).toBe("ts");
  });

  it("구분선 → divider", () => {
    expect(firstBlock("---").type).toBe("divider");
  });

  it("불릿 리스트 → bulletListItem 들이 평평하게 나온다", () => {
    const bs = astToBlocks(parseMarkdown("- 하나\n- 둘").blocks);
    expect(bs.map((b) => b.type)).toEqual(["bulletListItem", "bulletListItem"]);
  });

  it("체크박스 → checkListItem(checked)", () => {
    const bs = astToBlocks(parseMarkdown("- [x] 함").blocks);
    expect(bs[0].type).toBe("checkListItem");
    expect(bs[0].props?.checked).toBe(true);
  });

  it("번호 리스트 → numberedListItem, 첫 항목이 start 를 갖는다", () => {
    const bs = astToBlocks(parseMarkdown("3. 셋\n4. 넷").blocks);
    expect(bs[0].type).toBe("numberedListItem");
    expect(bs[0].props?.start).toBe(3);
    expect(bs[1].props?.start).toBeUndefined();
  });

  it("중첩 리스트 → children 으로 들어간다", () => {
    const bs = astToBlocks(parseMarkdown("- 상위\n  - 하위").blocks);
    expect(bs).toHaveLength(1);
    expect(bs[0].children?.[0].type).toBe("bulletListItem");
  });

  it("콜아웃 → callout(kind), 제목은 content·본문은 children", () => {
    const b = firstBlock("> [!WARNING] 주의\n> 본문");
    expect(b.type).toBe("callout");
    expect(b.props?.kind).toBe("WARNING");
    expect(b.children?.[0].type).toBe("paragraph");
  });

  it("임베드 → embed(target)", () => {
    const b = firstBlock("![[다른 노트]]");
    expect(b.type).toBe("embed");
    expect(b.props?.target).toBe("다른 노트");
  });

  it("표 → table + tableContent, 정렬은 셀 props 로", () => {
    const b = firstBlock("| A | B |\n| :-- | --: |\n| 1 | 2 |");
    expect(b.type).toBe("table");
    const tc = b.content as { type: string; rows: { cells: { props: { textAlignment: string } }[] }[] };
    expect(tc.type).toBe("tableContent");
    expect(tc.rows).toHaveLength(2); // 헤더 + 본문 1행
    expect(tc.rows[0].cells[1].props.textAlignment).toBe("right");
  });
});

describe("astToBlocks — 이미지", () => {
  it("이미지만 있는 문단은 네이티브 image 블록", () => {
    const b = firstBlock("![샷](/uploads/a.png)");
    expect(b.type).toBe("image");
    expect(b.props?.url).toBe("/uploads/a.png");
    expect(b.props?.caption).toBe("샷");
  });

  it("글 사이에 낀 이미지는 인라인으로 남는다", () => {
    const b = firstBlock("앞 ![샷](/a.png) 뒤");
    expect(b.type).toBe("paragraph");
    const content = b.content as { type: string }[];
    expect(content.map((c) => c.type)).toEqual(["text", "mdimage", "text"]);
  });
});

/* ───────────────────────── 인라인 매핑 ───────────────────────── */

describe("astToBlocks — 인라인 스타일", () => {
  const inlineOf = (md: string) => firstBlock(md).content as Record<string, unknown>[];

  it("굵게·기울임·취소선·코드·하이라이트가 styles 로", () => {
    expect(inlineOf("**a**")[0].styles).toEqual({ bold: true });
    expect(inlineOf("*a*")[0].styles).toEqual({ italic: true });
    expect(inlineOf("~~a~~")[0].styles).toEqual({ strike: true });
    expect(inlineOf("`a`")[0].styles).toEqual({ code: true });
    expect(inlineOf("==a==")[0].styles).toEqual({ highlight: true });
  });

  it("중첩 서식은 styles 가 합쳐진다", () => {
    const c = inlineOf("**굵고 *기운* 것**");
    expect(c[0].styles).toEqual({ bold: true });
    expect(c[1].styles).toEqual({ bold: true, italic: true });
  });

  it("서식 안의 인라인 코드는 코드만 남는다 — ProseMirror 가 code+다른 마크 결합을 거부한다", () => {
    // wrapStyles(직렬화 방향)의 계약과 동일: 코드가 이긴다.
    // {bold,code} 를 내보내면 editor.replaceBlocks 가 RangeError 로 터져 문서가 안 열린다.
    expect(inlineOf("**`booked`**")[0].styles).toEqual({ code: true });
    expect(inlineOf("**앞 `c` 뒤**").map((x) => x.styles)).toEqual([
      { bold: true },
      { code: true },
      { bold: true },
    ]);
    expect(inlineOf("*~~`x`~~*")[0].styles).toEqual({ code: true });
  });

  it("표준 링크 → link, 위키링크·태그 → 커스텀 인라인", () => {
    expect(inlineOf("[t](https://x.dev)")[0]).toMatchObject({ type: "link", href: "https://x.dev" });
    expect(inlineOf("[[대상|표시]]")[0]).toMatchObject({ type: "wikilink", props: { target: "대상", label: "표시" } });
    expect(inlineOf("#결정")[0]).toMatchObject({ type: "tag", props: { name: "결정" } });
  });
});

/* ───────────────────────── 왕복 ───────────────────────── */

describe("BlockNote 왕복 — 본문이 깎이지 않는다", () => {
  it("인라인 서식 전종", () => {
    stable("**굵게** *기울임* ~~취소~~ ==강조== `코드`");
  });

  it("링크·이미지·위키링크·태그", () => {
    stable("[문서](https://x.dev/a) [[대상|표시]] #결정");
    stable("![샷](/uploads/w/a.png)");
    stable("앞 ![샷](/a.png) 뒤");
  });

  it("대괄호 제목 위키링크", () => {
    stable("상위: [[[반장 핸드오프 B1] 시스템 아키텍처 개요]] · [[[반장] 핸드오프 문서 모음|허브]]");
    stable("![[[반장] 노트]]");
  });

  it("헤딩 6단", () => {
    stable("# 하나\n\n## 둘\n\n### 셋\n\n#### 넷\n\n##### 다섯\n\n###### 여섯");
  });

  it("중첩 리스트·체크박스·번호", () => {
    stable("- 상위\n  - 하위\n    - 더하위\n- 상위2");
    stable("- [ ] 안함\n- [x] 함");
    stable("3. 셋\n4. 넷");
  });

  it("코드펜스 — 내부 문법이 살아남는다", () => {
    stable("```ts\n# 제목 아님\n**굵게 아님**\n```");
  });

  it("표 — 정렬 유지", () => {
    stable("| 이름 | 값 |\n| :-- | --: |\n| **A** | 1 |");
  });

  it("인용·콜아웃·구분선·임베드", () => {
    stable("> 인용문");
    stable("> [!WARNING] 주의\n> 본문이다");
    stable("---");
    stable("![[설계 노트]]");
  });

  it("프론트매터는 블록 트리 밖에서 보존된다", () => {
    stable("---\ntitle: 로요\naliases: [LOYO, 단골노트]\n---\n\n본문");
  });

  it("복합 문서", () => {
    const md = [
      "# 개요",
      "",
      "**핵심**은 [[설계]] 와 #결정 이다.",
      "",
      "> [!NOTE] 참고",
      "> - 하나",
      "> - 둘",
      "",
      "| A | B |",
      "| :-- | --: |",
      "| 1 | 2 |",
      "",
      "```js",
      "if (a) { }",
      "```",
      "",
      "---",
      "",
      "![[다른 노트]]",
    ].join("\n");
    stable(md);
  });
});

describe("blocksToAst — 편집기가 만들 수 있는 형태도 받는다", () => {
  it("styles 가 비어 있어도 된다", () => {
    const blocks: BNBlock[] = [{ type: "paragraph", content: [{ type: "text", text: "a", styles: {} }] }];
    expect(serializeMarkdown({ frontmatter: null, blocks: blocksToAst(blocks) })).toBe("a");
  });

  it("content 가 없는 블록(빈 문단)도 견딘다", () => {
    const blocks: BNBlock[] = [{ type: "paragraph" }, { type: "paragraph", content: [{ type: "text", text: "b", styles: {} }] }];
    expect(serializeMarkdown({ frontmatter: null, blocks: blocksToAst(blocks) })).toBe("b");
  });

  it("모르는 블록 타입은 조용히 건너뛴다(데이터 유실보다 낫다)", () => {
    const blocks: BNBlock[] = [
      { type: "video", props: { url: "/v.mp4" } },
      { type: "paragraph", content: [{ type: "text", text: "뒤", styles: {} }] },
    ];
    expect(serializeMarkdown({ frontmatter: null, blocks: blocksToAst(blocks) })).toBe("뒤");
  });
});

/* ───────── 회귀: 편집기가 만들 수 있는 블록을 저장이 버리면 안 된다 ─────────
   전수조사(2026-08-07) P1. 슬래시 메뉴는 '토글 목록'·'토글 제목'을 제공하는데
   blocksToAst 가 toggleListItem 을 모르고 default:break 로 떨궜다. heading·paragraph
   케이스도 children 을 안 읽어, Tab 으로 들여쓴 하위 블록이 함께 사라졌다.
   저장은 "저장됨 ✓" 이라 새로고침 전까지 알 수 없는 조용한 본문 손실이었다. */

describe("blocksToAst — 중첩 children 을 잃지 않는다", () => {
  const md = (blocks: BNBlock[]) => serializeMarkdown({ frontmatter: null, blocks: blocksToAst(blocks) });
  const txt = (s: string): BNInline[] => [{ type: "text", text: s, styles: {} }];

  it("toggleListItem 은 불릿으로 내려가고 본문이 남는다", () => {
    const out = md([
      { type: "toggleListItem", content: txt("접히는 제목"), children: [{ type: "paragraph", content: txt("숨은 본문") }] },
    ]);
    expect(out).toContain("접히는 제목");
    expect(out).toContain("숨은 본문");
  });

  it("children 을 가진 heading 의 하위 블록이 살아남는다", () => {
    const out = md([
      { type: "heading", props: { level: 2 }, content: txt("제목"), children: [{ type: "paragraph", content: txt("들여쓴 본문") }] },
    ]);
    expect(out).toContain("## 제목");
    expect(out).toContain("들여쓴 본문");
  });

  it("children 을 가진 paragraph 의 하위 블록이 살아남는다", () => {
    const out = md([
      { type: "paragraph", content: txt("윗글"), children: [{ type: "paragraph", content: txt("아랫글") }] },
    ]);
    expect(out).toContain("윗글");
    expect(out).toContain("아랫글");
  });

  it("모르는 블록이라도 children 안의 글자는 잃지 않는다", () => {
    const out = md([
      { type: "someFutureBlock", content: txt("겉"), children: [{ type: "paragraph", content: txt("속 본문") }] },
    ]);
    expect(out).toContain("속 본문");
  });

  it("토글이 섞여도 왕복이 안정적이다(정규화 후 고정점)", () => {
    const once = md([
      { type: "toggleListItem", content: txt("A"), children: [{ type: "paragraph", content: txt("B") }] },
    ]);
    const twice = serializeMarkdown({ frontmatter: null, blocks: parseMarkdown(once).blocks });
    expect(twice).toBe(once);
  });
});
