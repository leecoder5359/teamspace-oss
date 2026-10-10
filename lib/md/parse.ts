/* =====================================================================
   마크다운 → AST 파서. 순수 함수(I/O·DOM 없음).

   범위는 "이 워크스페이스가 실제로 쓰는 문법"이다 — CommonMark 완전 구현이
   아니다. 대신 다음을 보장한다:
   - 코드(펜스·인라인) 내부는 어떤 문법도 해석하지 않는다.
   - 위키링크가 표준 링크보다 먼저 잡힌다([[A]] 가 [A](..) 로 오인되지 않게).
   - 강조 기호는 짝이 맞고 공백 규칙을 지킬 때만 서식이 된다
     (`2 * 3 * 4` 나 `snake_case` 가 기울어지지 않게).
   ===================================================================== */

import type { Align, Block, Doc, Frontmatter, Inline, ListItem, TableCell } from "./ast";
import { matchWikilinkAt } from "./wikilinkSyntax";

/* ───────────────────────── 인라인 ───────────────────────── */

const RE_CODE = /^`([^`]+)`/;
const RE_IMAGE = /^!\[([^\]]*)\]\(([^)\s]*)\)/;
const RE_LINK = /^\[([^\]]*)\]\(([^)\s]*)\)/;
const RE_STRONG = /^\*\*([\s\S]+?)\*\*/;
const RE_DEL = /^~~([\s\S]+?)~~/;
const RE_MARK = /^==([\s\S]+?)==/;
const RE_EM_STAR = /^\*([^\s*][\s\S]*?[^\s*]|[^\s*])\*/;
const RE_EM_UNDER = /^_([^\s_][\s\S]*?[^\s_]|[^\s_])_/;
const RE_TAG = /^#([\p{L}\p{N}_/-]*\p{L}[\p{L}\p{N}_/-]*)/u;

const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}_]/u.test(ch);

/**
 * 인라인 마크다운을 파싱한다. 매처 우선순위가 곧 문법 우선순위다.
 * 어떤 매처도 안 걸리면 그 글자는 텍스트 버퍼로 흘려보낸다.
 */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";

  const flush = () => {
    if (buf) {
      out.push({ t: "text", v: buf });
      buf = "";
    }
  };

  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const ch = src[i];
    const prev = i > 0 ? src[i - 1] : undefined;

    // 1) 인라인 코드 — 내부는 원문 그대로(다른 문법 해석 금지)
    if (ch === "`") {
      const m = RE_CODE.exec(rest);
      if (m) {
        flush();
        out.push({ t: "code", v: m[1] });
        i += m[0].length;
        continue;
      }
    }

    // 2) 이미지 — 링크보다 먼저(둘 다 [ 로 시작)
    if (ch === "!") {
      const m = RE_IMAGE.exec(rest);
      if (m) {
        flush();
        out.push({ t: "image", src: m[2], alt: m[1] });
        i += m[0].length;
        continue;
      }
    }

    if (ch === "[") {
      // 3) 위키링크 — 표준 링크보다 먼저([[A]] 가 [ + [A](..) 로 쪼개지지 않게)
      //    제목 안 대괄호([[[반장] 제목]])는 짝을 세어 바깥 ]] 까지 읽는다
      const w = matchWikilinkAt(src, i);
      if (w) {
        const [targetPart, labelPart] = w.inner.split("|");
        const target = targetPart.trim();
        if (target) {
          flush();
          out.push({ t: "wikilink", target, label: (labelPart ?? targetPart).trim() });
          i = w.end;
          continue;
        }
      }
      // 4) 표준 링크
      const l = RE_LINK.exec(rest);
      if (l) {
        flush();
        out.push({ t: "link", href: l[2], c: parseInline(l[1]) });
        i += l[0].length;
        continue;
      }
    }

    // 5) 강조 — ** 를 * 보다 먼저 본다
    if (ch === "*") {
      const s = RE_STRONG.exec(rest);
      if (s) {
        flush();
        out.push({ t: "strong", c: parseInline(s[1]) });
        i += s[0].length;
        continue;
      }
      const e = RE_EM_STAR.exec(rest);
      if (e) {
        flush();
        out.push({ t: "em", c: parseInline(e[1]) });
        i += e[0].length;
        continue;
      }
    }

    // 6) _기울임_ — snake_case 를 건드리지 않도록 앞뒤 단어경계를 본다
    if (ch === "_" && !isWordChar(prev)) {
      const e = RE_EM_UNDER.exec(rest);
      if (e && !isWordChar(src[i + e[0].length])) {
        flush();
        out.push({ t: "em", c: parseInline(e[1]) });
        i += e[0].length;
        continue;
      }
    }

    // 7) 취소선
    if (ch === "~") {
      const d = RE_DEL.exec(rest);
      if (d) {
        flush();
        out.push({ t: "del", c: parseInline(d[1]) });
        i += d[0].length;
        continue;
      }
    }

    // 8) 하이라이트
    if (ch === "=") {
      const m = RE_MARK.exec(rest);
      if (m) {
        flush();
        out.push({ t: "mark", c: parseInline(m[1]) });
        i += m[0].length;
        continue;
      }
    }

    // 9) #태그 — 줄머리나 공백 뒤에서만. 숫자만으로는 태그가 되지 않는다(A#12·#12 방지)
    if (ch === "#" && (i === 0 || /\s/.test(prev!))) {
      const m = RE_TAG.exec(rest);
      if (m) {
        flush();
        out.push({ t: "tag", name: m[1] });
        i += m[0].length;
        continue;
      }
    }

    buf += ch;
    i++;
  }

  flush();
  return out;
}

/* ───────────────────────── 블록 ───────────────────────── */

const RE_HEADING = /^(#{1,6})\s+(.*)$/;
const RE_HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const RE_FENCE = /^\s*```(.*)$/;
/** 한 줄이 통째로 ![[대상]] 인가 — 위키링크와 같은 경계 규칙(제목 안 대괄호 허용). */
function matchEmbed(line: string): string | null {
  const s = line.trim();
  if (s[0] !== "!") return null;
  const m = matchWikilinkAt(s, 1);
  return m && m.end === s.length ? m.inner : null;
}
const RE_QUOTE = /^>\s?(.*)$/;
const RE_CALLOUT = /^\[!([A-Za-z]+)\]\s*(.*)$/;
const RE_LIST_ITEM = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/;
const RE_TASK = /^\[([ xX])\]\s+(.*)$/;

const isBlank = (s: string) => s.trim() === "";
const indentOf = (s: string) => (s.match(/^\s*/)?.[0].replace(/\t/g, "    ").length ?? 0);

const isTableRow = (s: string) => /^\s*\|.*\|\s*$/.test(s);
const isTableSeparator = (s: string) => isTableRow(s) && /^\s*\|[\s:|-]+\|\s*$/.test(s) && s.includes("-");

/**
 * 표 행을 셀로 나눈다. 백틱 코드 스팬(같은 길이의 백틱으로 닫힘) 안의 `|` 는 구분자가 아니고,
 * `\|` 는 어디서든 리터럴 `|` 로 바꾼다. 닫히지 않은 백틱은 일반 글자로 보고 그대로 나눈다.
 */
function splitCells(line: string): string[] {
  const s = line.trim();
  const cells: string[] = [];
  let cur = "";
  let i = s.startsWith("|") ? 1 : 0;
  let endedWithSep = false;
  while (i < s.length) {
    endedWithSep = false;
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i += 2;
    } else if (ch === "`") {
      let n = 1;
      while (s[i + n] === "`") n++;
      const open = "`".repeat(n);
      // 같은 길이(정확히 n)의 닫는 백틱 런 찾기
      let j = i + n;
      let close = -1;
      while (j < s.length) {
        if (s[j] === "`") {
          let m = 1;
          while (s[j + m] === "`") m++;
          if (m === n) {
            close = j;
            break;
          }
          j += m;
        } else j++;
      }
      if (close === -1) {
        cur += open;
        i += n;
      } else {
        cur += open + s.slice(i + n, close).replace(/\\\|/g, "|") + open;
        i = close + n;
      }
    } else if (ch === "|") {
      cells.push(cur);
      cur = "";
      i++;
      endedWithSep = true;
    } else {
      cur += ch;
      i++;
    }
  }
  if (!endedWithSep || cur !== "") cells.push(cur);
  return cells.map((c) => c.trim());
}

function alignOf(cell: string): Align {
  const l = cell.startsWith(":");
  const r = cell.endsWith(":");
  if (l && r) return "center";
  if (r) return "right";
  return "left";
}

/** 리스트 항목 한 줄 분해. 매치 안 되면 null. */
function matchListItem(line: string) {
  const m = RE_LIST_ITEM.exec(line);
  if (!m) return null;
  const [, ws, bullet, num, text] = m;
  return {
    indent: ws.replace(/\t/g, "    ").length,
    ordered: !bullet,
    start: bullet ? 1 : parseInt(num, 10),
    text,
    markerWidth: (bullet ?? num + ".").length + 1,
  };
}

/** 공통 선행공백만큼 왼쪽으로 당긴다(중첩 블록 재귀 파싱용). */
function dedent(lines: string[]): string[] {
  const widths = lines.filter((l) => !isBlank(l)).map(indentOf);
  const min = widths.length ? Math.min(...widths) : 0;
  return lines.map((l) => (isBlank(l) ? "" : l.slice(min)));
}

/** 블록 목록을 파싱한다. 인용·리스트 항목 내부에서도 재귀로 쓰인다. */
export function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      i++;
      continue;
    }

    // 코드펜스 — 닫히지 않아도 파일 끝에서 마감한다
    const fence = RE_FENCE.exec(line);
    if (fence) {
      const lang = fence[1].trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !RE_FENCE.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // 닫는 펜스(또는 EOF) 소비
      out.push({ t: "code", lang: lang || null, v: body.join("\n") });
      continue;
    }

    // 표 — 헤더 + 구분선이 붙어 있을 때만 표로 본다
    if (isTableRow(line) && isTableSeparator(lines[i + 1] ?? "")) {
      const head = splitCells(line).map<TableCell>((c) => ({ c: parseInline(c) }));
      const align = splitCells(lines[i + 1]).map(alignOf);
      i += 2;
      const rows: TableCell[][] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(splitCells(lines[i]).map<TableCell>((c) => ({ c: parseInline(c) })));
        i++;
      }
      out.push({ t: "table", align, head, rows });
      continue;
    }

    // 임베드(트랜스클루전) — 한 줄이 통째로 ![[대상]] 일 때만
    const emb = matchEmbed(line);
    if (emb !== null) {
      out.push({ t: "embed", target: emb.split("|")[0].trim() });
      i++;
      continue;
    }

    // 헤딩 — '#' 뒤 공백이 있어야 한다(#태그 와 구분)
    const h = RE_HEADING.exec(line);
    if (h) {
      out.push({ t: "heading", level: h[1].length as 1 | 2 | 3 | 4 | 5 | 6, c: parseInline(h[2].trim()) });
      i++;
      continue;
    }

    // 구분선
    if (RE_HR.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }

    // 인용 / 콜아웃 — 연속된 '>' 줄을 모아 내부를 재귀 파싱
    if (RE_QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        inner.push(RE_QUOTE.exec(lines[i])![1]);
        i++;
      }
      const co = RE_CALLOUT.exec(inner[0] ?? "");
      if (co) {
        const titleText = co[2].trim();
        out.push({
          t: "callout",
          kind: co[1].toUpperCase(),
          title: titleText ? parseInline(titleText) : null,
          c: parseBlocks(inner.slice(1)),
        });
      } else {
        out.push({ t: "quote", c: parseBlocks(inner) });
      }
      continue;
    }

    // 리스트 — 들여쓰기로 중첩을 만든다
    const li = matchListItem(line);
    if (li) {
      const [block, next] = parseList(lines, i);
      out.push(block);
      i = next;
      continue;
    }

    // 문단 — 다음 블록 시작이나 빈 줄 전까지 이어붙인다(소프트 줄바꿈 = 공백)
    const para: string[] = [];
    while (i < lines.length && !isBlank(lines[i]) && !startsNewBlock(lines[i], lines[i + 1] ?? "")) {
      para.push(lines[i].trim());
      i++;
    }
    if (para.length) {
      out.push({ t: "para", c: parseInline(para.join(" ")) });
    } else {
      // 방어: 어떤 분기도 진행하지 못하면 한 줄 소비해 무한루프를 막는다
      out.push({ t: "para", c: parseInline(lines[i].trim()) });
      i++;
    }
  }

  return out;
}

/** 문단 이어붙이기를 멈춰야 하는 줄인가. */
function startsNewBlock(line: string, next: string): boolean {
  return (
    RE_HEADING.test(line) ||
    RE_HR.test(line) ||
    RE_FENCE.test(line) ||
    RE_QUOTE.test(line) ||
    matchEmbed(line) !== null ||
    matchListItem(line) !== null ||
    (isTableRow(line) && isTableSeparator(next))
  );
}

/** lines[start] 부터 하나의 리스트 블록을 만든다. [블록, 다음 인덱스] 반환. */
function parseList(lines: string[], start: number): [Block, number] {
  const first = matchListItem(lines[start])!;
  const baseIndent = first.indent;
  const ordered = first.ordered;
  const items: ListItem[] = [];
  let i = start;

  while (i < lines.length) {
    if (isBlank(lines[i])) {
      // 빈 줄 뒤가 이 리스트의 연속이면 이어가고, 아니면 끝낸다
      let j = i;
      while (j < lines.length && isBlank(lines[j])) j++;
      if (j >= lines.length) break;
      const peek = matchListItem(lines[j]);
      const continues = indentOf(lines[j]) > baseIndent || (peek && peek.indent === baseIndent && peek.ordered === ordered);
      if (!continues) break;
      i = j;
      continue;
    }

    const m = matchListItem(lines[i]);
    if (!m || m.indent < baseIndent) break;
    // 같은 깊이인데 종류가 다르면(불릿↔번호) 별개 리스트로 가른다
    if (m.indent === baseIndent && m.ordered !== ordered) break;
    if (m.indent > baseIndent) {
      // 앞선 항목의 자식으로 흡수돼야 정상. 항목 없이 들어오면 방어적으로 종료.
      if (!items.length) break;
    }

    // 항목 본문 — 체크박스 여부 분리
    let text = m.text;
    let checked: boolean | null = null;
    const task = RE_TASK.exec(text);
    if (task) {
      checked = task[1].toLowerCase() === "x";
      text = task[2];
    }
    i++;

    // 이 항목에 딸린 더 깊은 줄들을 모아 재귀 파싱
    const childLines: string[] = [];
    while (i < lines.length) {
      if (isBlank(lines[i])) {
        let j = i;
        while (j < lines.length && isBlank(lines[j])) j++;
        if (j < lines.length && indentOf(lines[j]) > baseIndent) {
          childLines.push("");
          i++;
          continue;
        }
        break;
      }
      if (indentOf(lines[i]) > baseIndent) {
        childLines.push(lines[i]);
        i++;
        continue;
      }
      break;
    }

    items.push({
      c: parseInline(text.trim()),
      checked,
      children: childLines.length ? parseBlocks(dedent(childLines)) : [],
    });
  }

  return [{ t: "list", ordered, start: first.start, items }, i];
}

/* ───────────────────────── 프론트매터 ───────────────────────── */

const stripQuotes = (s: string) => s.replace(/^["'](.*)["']$/, "$1").trim();

/**
 * 아주 작은 YAML 부분집합만 읽는다 — `key: 값`, `key: [a, b]`, 그리고
 * 다음 줄들의 `  - 항목` 리스트. 중첩 맵·복합 타입은 지원하지 않는다.
 * (프론트매터의 실제 용도가 title·aliases·tags 뿐이라 여기서 멈춘다.)
 */
export function parseFrontmatter(lines: string[]): Frontmatter {
  const fm: Frontmatter = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1];
    const raw = m[2].trim();
    i++;

    if (raw.startsWith("[") && raw.endsWith("]")) {
      fm[key] = raw
        .slice(1, -1)
        .split(",")
        .map((s) => stripQuotes(s.trim()))
        .filter(Boolean);
      continue;
    }
    if (raw === "") {
      // 다음 줄들이 `- 항목` 이면 배열
      const arr: string[] = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i])) {
        arr.push(stripQuotes(lines[i].replace(/^\s*-\s+/, "").trim()));
        i++;
      }
      if (arr.length) fm[key] = arr;
      continue;
    }
    fm[key] = stripQuotes(raw);
  }
  return fm;
}

/* ───────────────────────── 진입점 ───────────────────────── */

/**
 * 프론트매터만 떼어낸다 — 본문은 파싱하지 않는다.
 * 별칭 색인처럼 전체 문서를 훑어야 하는 자리에서 본문까지 파싱하면
 * 페이지 수에 비례해 낭비가 커진다.
 */
export function extractFrontmatter(src: string): { frontmatter: Frontmatter | null; body: string } {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return { frontmatter: null, body: src };
  const close = lines.findIndex((l, idx) => idx > 0 && l.trim() === "---");
  if (close <= 0) return { frontmatter: null, body: src };
  return { frontmatter: parseFrontmatter(lines.slice(1, close)), body: lines.slice(close + 1).join("\n") };
}

/** 마크다운 원문 → Doc. 프론트매터는 첫 줄이 `---` 일 때만 인정한다. */
export function parseMarkdown(src: string): Doc {
  const { frontmatter, body } = extractFrontmatter(src);
  return { frontmatter, blocks: parseBlocks(body.replace(/\r\n?/g, "\n").split("\n")) };
}
