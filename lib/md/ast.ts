/* =====================================================================
   마크다운 AST — 파서 하나를 두 렌더러가 공유하기 위한 중간 표현.

   왜 AST 를 두는가: 종전엔 MarkdownPreview 가 줄 단위로 직접 React 를
   뱉었다. 여기에 BlockNote 변환까지 얹으면 마크다운 문법 해석이 두 벌로
   갈라지고, 한쪽만 고치는 순간 "미리보기와 편집기가 다르게 보이는" 버그가
   시작된다. 파싱은 한 번만 하고 AST 를 두 방향으로 렌더한다.
   ===================================================================== */

export type Align = "left" | "center" | "right";

/** 인라인 노드. text 를 제외하면 전부 자식을 갖거나 원자값이다. */
export type Inline =
  | { t: "text"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "del"; c: Inline[] }
  /** ==하이라이트== */
  | { t: "mark"; c: Inline[] }
  /** 인라인 코드 — 내부는 원문 보존(다른 문법 해석 안 함) */
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "image"; src: string; alt: string }
  /** [[대상]] · [[대상|표시]] */
  | { t: "wikilink"; target: string; label: string }
  /** #태그 */
  | { t: "tag"; name: string };

export type ListItem = {
  c: Inline[];
  /** null = 일반 항목, boolean = 체크박스 항목 */
  checked: boolean | null;
  /** 중첩 리스트 등 하위 블록 */
  children: Block[];
};

export type TableCell = { c: Inline[] };

export type Block =
  | { t: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; c: Inline[] }
  | { t: "para"; c: Inline[] }
  /** 인용 — 다중행·중첩을 위해 자식이 블록이다 */
  | { t: "quote"; c: Block[] }
  /** 옵시디언식 콜아웃: > [!NOTE] 제목 */
  | { t: "callout"; kind: string; title: Inline[] | null; c: Block[] }
  | { t: "code"; lang: string | null; v: string }
  | { t: "table"; align: Align[]; head: TableCell[]; rows: TableCell[][] }
  | { t: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { t: "hr" }
  /** ![[문서]] — 트랜스클루전(임베드) */
  | { t: "embed"; target: string };

export type Frontmatter = Record<string, string | string[]>;

export type Doc = {
  frontmatter: Frontmatter | null;
  blocks: Block[];
};

/* ---------- 작은 헬퍼 (렌더러·변환기 공용) ---------- */

/** 인라인 트리에서 순수 텍스트만 뽑는다(제목 슬러그·검색 스니펫용). */
export function inlineText(nodes: Inline[]): string {
  let out = "";
  for (const n of nodes) {
    switch (n.t) {
      case "text":
        out += n.v;
        break;
      case "code":
        out += n.v;
        break;
      case "image":
        out += n.alt;
        break;
      case "wikilink":
        out += n.label;
        break;
      case "tag":
        out += "#" + n.name;
        break;
      default:
        out += inlineText(n.c);
    }
  }
  return out;
}

/** 자식 인라인을 갖는 노드만 골라낸다 — wikilink·tag 처럼 원자값인 노드를 재귀에서 뺀다. */
type InlineWithChildren = Extract<Inline, { c: Inline[] }>;
function inlineChildren(n: Inline): Inline[] | null {
  return (n as InlineWithChildren).c ?? null;
}

/** 문서에 등장하는 #태그 이름 목록(등장순·중복제거·대소문자 무시 비교). */
export function collectTags(blocks: Block[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walkInline = (nodes: Inline[]) => {
    for (const n of nodes) {
      if (n.t === "tag") {
        const key = n.name.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          out.push(n.name);
        }
        continue;
      }
      const kids = inlineChildren(n);
      if (kids) walkInline(kids);
    }
  };
  walkBlocks(blocks, walkInline);
  return out;
}

/** 문서가 참조하는 위키링크·임베드 대상 목록(등장순·중복제거). */
export function collectLinks(blocks: Block[]): { target: string; embed: boolean }[] {
  const out: { target: string; embed: boolean }[] = [];
  const seen = new Set<string>();
  const push = (target: string, embed: boolean) => {
    const key = (embed ? "!" : "") + target.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ target, embed });
  };
  const walkInline = (nodes: Inline[]) => {
    for (const n of nodes) {
      if (n.t === "wikilink") {
        push(n.target, false);
        continue;
      }
      const kids = inlineChildren(n);
      if (kids) walkInline(kids);
    }
  };
  const walk = (bs: Block[]) => {
    for (const b of bs) {
      if (b.t === "embed") push(b.target, true);
    }
  };
  walkBlocks(blocks, walkInline);
  walk(blocks);
  return out;
}

/** 블록 트리를 훑으며 인라인 배열마다 콜백. 중첩(인용·콜아웃·리스트·표) 포함. */
export function walkBlocks(blocks: Block[], onInline: (nodes: Inline[]) => void): void {
  for (const b of blocks) {
    switch (b.t) {
      case "heading":
      case "para":
        onInline(b.c);
        break;
      case "quote":
        walkBlocks(b.c, onInline);
        break;
      case "callout":
        if (b.title) onInline(b.title);
        walkBlocks(b.c, onInline);
        break;
      case "table":
        for (const cell of b.head) onInline(cell.c);
        for (const row of b.rows) for (const cell of row) onInline(cell.c);
        break;
      case "list":
        for (const it of b.items) {
          onInline(it.c);
          walkBlocks(it.children, onInline);
        }
        break;
      // code · hr · embed 는 인라인 없음
    }
  }
}
