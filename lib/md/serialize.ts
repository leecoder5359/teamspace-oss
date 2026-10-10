/* =====================================================================
   AST → 마크다운 직렬화. 순수 함수.

   파서의 역방향이지만 "입력을 글자 그대로 복원"하지는 않는다 — 같은 뜻을
   가진 표기가 여럿이기 때문이다(*기울임* 과 _기울임_, - 와 *, --- 와 ***).
   그래서 하나의 정규형(canonical form)을 정하고 거기로 수렴시킨다:

     기울임 = *…*   ·  불릿 = "- "  ·  번호 = "N. "  ·  구분선 = "---"
     중첩 들여쓰기 = 2칸  ·  블록 사이 빈 줄 1개

   왕복 계약은 "원문 == 직렬화(파싱(원문))" 이 아니라
   "직렬화(파싱(x)) == 직렬화(파싱(직렬화(파싱(x))))" — 즉 한 번 정규화되면
   이후로는 고정점이다. 이게 보장돼야 문서를 열고 저장할 때마다 본문이
   조금씩 흔들리는 일이 없다.
   ===================================================================== */

import type { Block, Doc, Frontmatter, Inline } from "./ast";

/* ───────────────────────── 인라인 ───────────────────────── */

export function serializeInline(nodes: Inline[]): string {
  return nodes.map(serializeInlineNode).join("");
}

function serializeInlineNode(n: Inline): string {
  switch (n.t) {
    case "text":
      return n.v;
    case "strong":
      return `**${serializeInline(n.c)}**`;
    case "em":
      return `*${serializeInline(n.c)}*`;
    case "del":
      return `~~${serializeInline(n.c)}~~`;
    case "mark":
      return `==${serializeInline(n.c)}==`;
    case "code":
      return `\`${n.v}\``;
    case "link":
      return `[${serializeInline(n.c)}](${n.href})`;
    case "image":
      return `![${n.alt}](${n.src})`;
    case "wikilink":
      return n.label === n.target ? `[[${n.target}]]` : `[[${n.target}|${n.label}]]`;
    case "tag":
      return `#${n.name}`;
  }
}

/* ───────────────────────── 블록 ───────────────────────── */

/** 각 줄 앞에 접두어를 붙인다(인용·콜아웃용). 빈 줄엔 공백을 남기지 않는다. */
function prefixLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((l) => (l ? prefix + l : prefix.trimEnd()))
    .join("\n");
}

function serializeList(b: Extract<Block, { t: "list" }>): string {
  const out: string[] = [];
  b.items.forEach((item, idx) => {
    const marker = b.ordered ? `${b.start + idx}. ` : "- ";
    const box = item.checked === null ? "" : item.checked ? "[x] " : "[ ] ";
    out.push(marker + box + serializeInline(item.c));
    if (item.children.length) {
      // 중첩은 2칸 들여쓰기 — 파서의 indentOf 가 이 폭을 그대로 읽는다
      out.push(prefixLines(serializeBlocks(item.children), "  "));
    }
  });
  return out.join("\n");
}

function serializeTable(b: Extract<Block, { t: "table" }>): string {
  const sep = b.align.map((a) => (a === "center" ? ":--:" : a === "right" ? "--:" : ":--"));
  const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
  // 셀 안의 `|` 는 구분자와 구별되도록 `\\|` 로 이스케이프(파서가 되돌림)
  const cell = (c: { c: Parameters<typeof serializeInline>[0] }) => serializeInline(c.c).replace(/\|/g, "\\|");
  const lines = [
    row(b.head.map(cell)),
    row(sep),
    ...b.rows.map((r) => row(r.map(cell))),
  ];
  return lines.join("\n");
}

function serializeBlock(b: Block): string {
  switch (b.t) {
    case "heading":
      return `${"#".repeat(b.level)} ${serializeInline(b.c)}`;
    case "para":
      return serializeInline(b.c);
    case "quote":
      return prefixLines(serializeBlocks(b.c), "> ");
    case "callout": {
      const head = `> [!${b.kind}]${b.title ? " " + serializeInline(b.title) : ""}`;
      const body = b.c.length ? "\n" + prefixLines(serializeBlocks(b.c), "> ") : "";
      return head + body;
    }
    case "code":
      return `\`\`\`${b.lang ?? ""}\n${b.v}\n\`\`\``;
    case "table":
      return serializeTable(b);
    case "list":
      return serializeList(b);
    case "hr":
      return "---";
    case "embed":
      return `![[${b.target}]]`;
  }
}

/** 블록 사이는 빈 줄 하나. 리스트 안에서도 같은 규칙이라 중첩이 안전하다. */
export function serializeBlocks(blocks: Block[]): string {
  return blocks.map(serializeBlock).join("\n\n");
}

/* ───────────────────────── 프론트매터 ───────────────────────── */

export function serializeFrontmatter(fm: Frontmatter): string {
  const lines = Object.entries(fm).map(([k, v]) =>
    Array.isArray(v) ? `${k}: [${v.join(", ")}]` : `${k}: ${v}`,
  );
  return ["---", ...lines, "---"].join("\n");
}

/* ───────────────────────── 진입점 ───────────────────────── */

export function serializeMarkdown(doc: Doc): string {
  const body = serializeBlocks(doc.blocks);
  if (!doc.frontmatter || Object.keys(doc.frontmatter).length === 0) return body;
  return serializeFrontmatter(doc.frontmatter) + "\n\n" + body;
}
