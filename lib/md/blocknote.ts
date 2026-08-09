/* =====================================================================
   AST ↔ BlockNote 블록 변환. 순수 함수(에디터 런타임 import 없음).

   왜 BlockNote 의 blocksToMarkdownLossy 를 안 쓰는가:
   이름 그대로 손실이 있다. 문서를 열 때마다 md→blocks, 저장할 때마다
   blocks→md 를 타므로, 손실이 있으면 사용자가 아무것도 안 고쳐도
   **열고 닫는 것만으로 본문이 조금씩 깎인다.** 게다가 위키링크·태그·
   임베드·콜아웃은 BlockNote 가 아예 모르는 문법이라 통째로 사라진다.

   그래서 변환을 직접 소유하고, 왕복 고정점을 테스트로 잠근다.

   알려진 축약(테스트로 고정된 의도적 동작):
   - 링크 라벨 안의 위키링크·태그는 평문으로 눕는다(BlockNote link 의
     content 가 StyledText 만 받는다). 링크 라벨에 링크를 넣는 건
     마크다운에서도 불가라 실사용 손실은 없다.
   - 모르는 블록 타입(video·audio·file 등)은 건너뛴다. 마크다운으로
     표현할 방법이 없어서이고, 조용히 깨진 텍스트를 남기는 것보다 낫다.
   ===================================================================== */

import type { Align, Block, Inline, ListItem } from "./ast";

/* ───────────────────────── BlockNote 형태 ───────────────────────── */

export type BNStyles = Partial<Record<"bold" | "italic" | "underline" | "strike" | "code" | "highlight", true>>;

export type BNText = { type: "text"; text: string; styles: BNStyles };
export type BNLink = { type: "link"; href: string; content: BNText[] };
export type BNWikilink = { type: "wikilink"; props: { target: string; label: string } };
export type BNTag = { type: "tag"; props: { name: string } };
export type BNImageInline = { type: "mdimage"; props: { src: string; alt: string } };
export type BNInline = BNText | BNLink | BNWikilink | BNTag | BNImageInline;

export type BNTableCell = {
  type: "tableCell";
  props: { textAlignment: Align; colspan: number; rowspan: number };
  content: BNInline[];
};
export type BNTableContent = {
  type: "tableContent";
  columnWidths: (number | undefined)[];
  headerRows: number;
  rows: { cells: BNTableCell[] }[];
};

export type BNBlock = {
  type: string;
  props?: Record<string, unknown>;
  content?: BNInline[] | BNTableContent;
  children?: BNBlock[];
};

/* ───────────────────────── 인라인: AST → BN ───────────────────────── */

/** 스타일이 누적되며 내려간다(굵게 안의 기울임 → {bold,italic}). */
function inlineToBN(nodes: Inline[], styles: BNStyles = {}): BNInline[] {
  const out: BNInline[] = [];
  for (const n of nodes) {
    switch (n.t) {
      case "text":
        if (n.v) out.push({ type: "text", text: n.v, styles: { ...styles } });
        break;
      case "strong":
        out.push(...inlineToBN(n.c, { ...styles, bold: true }));
        break;
      case "em":
        out.push(...inlineToBN(n.c, { ...styles, italic: true }));
        break;
      case "del":
        out.push(...inlineToBN(n.c, { ...styles, strike: true }));
        break;
      case "mark":
        out.push(...inlineToBN(n.c, { ...styles, highlight: true }));
        break;
      case "code":
        // wrapStyles(역방향)와 같은 계약: 코드가 이긴다. code 를 다른 마크와 겹치면
        // ProseMirror 가 "Invalid collection of marks" 로 거부해 문서 로드가 통째로 죽는다.
        out.push({ type: "text", text: n.v, styles: { code: true } });
        break;
      case "link":
        out.push({ type: "link", href: n.href, content: flattenToText(n.c, styles) });
        break;
      case "image":
        out.push({ type: "mdimage", props: { src: n.src, alt: n.alt } });
        break;
      case "wikilink":
        out.push({ type: "wikilink", props: { target: n.target, label: n.label } });
        break;
      case "tag":
        out.push({ type: "tag", props: { name: n.name } });
        break;
    }
  }
  return out;
}

/** BlockNote link 는 StyledText 만 담는다 — 그 안의 비텍스트는 평문으로 눕힌다. */
function flattenToText(nodes: Inline[], styles: BNStyles): BNText[] {
  const out: BNText[] = [];
  for (const bn of inlineToBN(nodes, styles)) {
    if (bn.type === "text") out.push(bn);
    else if (bn.type === "link") out.push(...bn.content);
    else if (bn.type === "wikilink") out.push({ type: "text", text: bn.props.label, styles: { ...styles } });
    else if (bn.type === "tag") out.push({ type: "text", text: "#" + bn.props.name, styles: { ...styles } });
    else if (bn.type === "mdimage") out.push({ type: "text", text: bn.props.alt, styles: { ...styles } });
  }
  return out;
}

/* ───────────────────────── 인라인: BN → AST ───────────────────────── */

const STYLE_ORDER: [keyof BNStyles, Inline["t"]][] = [
  ["code", "code"], // 코드가 가장 안쪽 — 내부를 다른 서식으로 감싸지 않는다
  ["highlight", "mark"],
  ["strike", "del"],
  ["italic", "em"],
  ["bold", "strong"],
];

/** styles 를 중첩 AST 로 되돌린다. 순서를 고정해야 왕복이 안정된다. */
function wrapStyles(text: string, styles: BNStyles): Inline {
  if (styles.code) {
    // 인라인 코드는 다른 서식과 겹쳐도 마크다운에 표현할 수 없다 — 코드가 이긴다
    return { t: "code", v: text };
  }
  let node: Inline = { t: "text", v: text };
  for (const [key, kind] of STYLE_ORDER) {
    if (key === "code" || !styles[key]) continue;
    node = { t: kind, c: [node] } as Inline;
  }
  return node;
}

function inlineToAst(content: BNInline[] | undefined): Inline[] {
  if (!content) return [];
  const out: Inline[] = [];
  for (const c of content) {
    switch (c.type) {
      case "text":
        out.push(wrapStyles(c.text, c.styles ?? {}));
        break;
      case "link":
        out.push({ t: "link", href: c.href, c: inlineToAst(c.content) });
        break;
      case "wikilink":
        out.push({ t: "wikilink", target: c.props.target, label: c.props.label });
        break;
      case "tag":
        out.push({ t: "tag", name: c.props.name });
        break;
      case "mdimage":
        out.push({ t: "image", src: c.props.src, alt: c.props.alt });
        break;
    }
  }
  return mergeAdjacentText(out);
}

/** 같은 서식의 연속 텍스트를 합쳐 `**a****b**` 같은 산출물을 막는다. */
function mergeAdjacentText(nodes: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (n.t === "text" && prev?.t === "text") {
      out[out.length - 1] = { t: "text", v: prev.v + n.v };
      continue;
    }
    if (prev && n.t === prev.t && (n.t === "strong" || n.t === "em" || n.t === "del" || n.t === "mark")) {
      const merged = mergeAdjacentText([...(prev as { c: Inline[] }).c, ...n.c]);
      out[out.length - 1] = { t: n.t, c: merged } as Inline;
      continue;
    }
    out.push(n);
  }
  return out;
}

/* ───────────────────────── 블록: AST → BN ───────────────────────── */

function listItemsToBN(items: ListItem[], ordered: boolean, start: number): BNBlock[] {
  return items.map((item, idx) => {
    const type = item.checked !== null ? "checkListItem" : ordered ? "numberedListItem" : "bulletListItem";
    const props: Record<string, unknown> = {};
    if (item.checked !== null) props.checked = item.checked;
    // start 는 첫 항목에만 — BlockNote 가 이후를 자동 증가시킨다
    if (ordered && idx === 0 && start !== 1) props.start = start;
    const block: BNBlock = { type, content: inlineToBN(item.c) };
    if (Object.keys(props).length) block.props = props;
    if (item.children.length) block.children = astToBlocks(item.children);
    return block;
  });
}

/** 문단이 이미지 하나뿐이면 네이티브 image 블록으로 승격(리사이즈·캡션 UX). */
function soleImage(c: Inline[]): Extract<Inline, { t: "image" }> | null {
  const meaningful = c.filter((n) => !(n.t === "text" && !n.v.trim()));
  return meaningful.length === 1 && meaningful[0].t === "image" ? meaningful[0] : null;
}

export function astToBlocks(blocks: Block[]): BNBlock[] {
  const out: BNBlock[] = [];

  for (const b of blocks) {
    switch (b.t) {
      case "heading":
        out.push({ type: "heading", props: { level: b.level }, content: inlineToBN(b.c) });
        break;

      case "para": {
        const img = soleImage(b.c);
        if (img) {
          out.push({ type: "image", props: { url: img.src, caption: img.alt } });
        } else {
          out.push({ type: "paragraph", content: inlineToBN(b.c) });
        }
        break;
      }

      case "quote":
        out.push({ type: "quote", content: [], children: astToBlocks(b.c) });
        break;

      case "callout":
        out.push({
          type: "callout",
          props: { kind: b.kind },
          content: b.title ? inlineToBN(b.title) : [],
          children: astToBlocks(b.c),
        });
        break;

      case "code":
        out.push({ type: "codeBlock", props: { language: b.lang ?? "" }, content: b.v ? [{ type: "text", text: b.v, styles: {} }] : [] });
        break;

      case "hr":
        out.push({ type: "divider" });
        break;

      case "embed":
        out.push({ type: "embed", props: { target: b.target } });
        break;

      case "list":
        out.push(...listItemsToBN(b.items, b.ordered, b.start));
        break;

      case "table": {
        const mkCell = (cell: { c: Inline[] }, ci: number): BNTableCell => ({
          type: "tableCell",
          props: { textAlignment: b.align[ci] ?? "left", colspan: 1, rowspan: 1 },
          content: inlineToBN(cell.c),
        });
        const content: BNTableContent = {
          type: "tableContent",
          columnWidths: b.head.map(() => undefined),
          headerRows: 1,
          rows: [{ cells: b.head.map(mkCell) }, ...b.rows.map((r) => ({ cells: r.map(mkCell) }))],
        };
        out.push({ type: "table", content });
        break;
      }
    }
  }

  return out;
}

/* ───────────────────────── 블록: BN → AST ───────────────────────── */

// 토글도 리스트 항목으로 본다 — 마크다운에 '접힘' 표현이 없으므로 불릿으로 내리고
// children 을 중첩 리스트로 보존한다. 접힘 상태만 잃고 글자는 하나도 안 잃는다.
const LIST_TYPES = new Set(["bulletListItem", "numberedListItem", "checkListItem", "toggleListItem"]);

export function blocksToAst(blocks: BNBlock[]): Block[] {
  const out: Block[] = [];
  let i = 0;

  while (i < blocks.length) {
    const b = blocks[i];

    // 리스트 항목들은 연속 구간을 하나의 list 블록으로 되묶는다
    if (LIST_TYPES.has(b.type)) {
      const ordered = b.type === "numberedListItem";
      const items: ListItem[] = [];
      const start = typeof b.props?.start === "number" ? (b.props.start as number) : 1;

      while (i < blocks.length && LIST_TYPES.has(blocks[i].type)) {
        const cur = blocks[i];
        const curOrdered = cur.type === "numberedListItem";
        // 불릿↔번호가 바뀌면 별개 리스트. 체크리스트는 어느 쪽과도 섞이지 않는다.
        const isCheck = cur.type === "checkListItem";
        const wasCheck = items.length > 0 && items[0].checked !== null;
        if (items.length && (curOrdered !== ordered || isCheck !== wasCheck)) break;

        items.push({
          c: inlineToAst(cur.content as BNInline[] | undefined),
          checked: isCheck ? cur.props?.checked === true : null,
          children: cur.children ? blocksToAst(cur.children) : [],
        });
        i++;
      }
      out.push({ t: "list", ordered, start, items });
      continue;
    }

    i++;

    switch (b.type) {
      case "heading": {
        const lvl = Number(b.props?.level ?? 1);
        const level = (lvl >= 1 && lvl <= 6 ? lvl : 1) as 1 | 2 | 3 | 4 | 5 | 6;
        out.push({ t: "heading", level, c: inlineToAst(b.content as BNInline[] | undefined) });
        // 접히는 제목(isToggleable)이나 Tab 으로 들여쓴 하위 블록 — 마크다운엔 담을 그릇이
        // 없으니 평평하게 뒤에 잇는다. 계층은 잃어도 글자는 잃지 않는다.
        if (b.children?.length) out.push(...blocksToAst(b.children));
        break;
      }

      case "paragraph": {
        const c = inlineToAst(b.content as BNInline[] | undefined);
        // 완전히 빈 문단은 버린다 — 저장할 때마다 빈 줄이 늘어나는 걸 막는다
        if (c.length) out.push({ t: "para", c });
        if (b.children?.length) out.push(...blocksToAst(b.children));
        break;
      }

      case "quote": {
        const inner = b.children ? blocksToAst(b.children) : [];
        const lead = inlineToAst(b.content as BNInline[] | undefined);
        out.push({ t: "quote", c: lead.length ? [{ t: "para", c: lead }, ...inner] : inner });
        break;
      }

      case "callout": {
        const title = inlineToAst(b.content as BNInline[] | undefined);
        out.push({
          t: "callout",
          kind: String(b.props?.kind ?? "NOTE").toUpperCase(),
          title: title.length ? title : null,
          c: b.children ? blocksToAst(b.children) : [],
        });
        break;
      }

      case "codeBlock": {
        const content = b.content as BNInline[] | undefined;
        const text = (content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
        const lang = String(b.props?.language ?? "");
        out.push({ t: "code", lang: lang || null, v: text });
        break;
      }

      case "divider":
      case "pageBreak":
        out.push({ t: "hr" });
        break;

      case "embed":
        out.push({ t: "embed", target: String(b.props?.target ?? "") });
        break;

      case "image": {
        const src = String(b.props?.url ?? "");
        const alt = String(b.props?.caption ?? "");
        if (src) out.push({ t: "para", c: [{ t: "image", src, alt }] });
        break;
      }

      case "table": {
        const tc = b.content as BNTableContent | undefined;
        if (!tc?.rows?.length) break;
        const headerRows = tc.headerRows ?? 1;
        const cellsOf = (row: { cells: BNTableCell[] }) => row.cells.map((c) => ({ c: inlineToAst(c.content) }));
        const head = cellsOf(tc.rows[0]);
        const align: Align[] = tc.rows[0].cells.map((c) => c.props?.textAlignment ?? "left");
        out.push({ t: "table", align, head, rows: tc.rows.slice(headerRows).map(cellsOf) });
        break;
      }

      // video·audio·file 등 마크다운으로 표현할 수 없는 블록은 자체는 건너뛴다.
      // 다만 children 은 반드시 건진다 — 모르는 블록 하나 때문에 그 안의 글이
      // 통째로 사라지면 안 된다(전수조사 P1). 앞으로 BlockNote 가 블록을 추가해도
      // 이 분기가 데이터 손실로 이어지지 않는다.
      default:
        if (b.children?.length) out.push(...blocksToAst(b.children));
        break;
    }
  }

  return out;
}
