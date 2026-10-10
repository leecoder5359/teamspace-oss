/* =====================================================================
   헤딩 id·목차(TOC) — 순수 함수.

   미리보기(MarkdownPreview)와 목차(DocToc)가 같은 규칙으로 id 를 만들어야
   "#설치" 링크가 실제 헤딩에 꽂힌다. 그래서 슬러그·중복 처리는 여기 한 곳에만
   둔다. 순번은 h1~h6 전체를 등장 순서대로 매긴다 — 미리보기는 모든 헤딩에
   id 를 주므로, TOC 가 h1~h3 만 따로 세면 `#### 예시` 다음 `## 예시` 의 번호가
   어긋난다.
   ===================================================================== */

import { parseMarkdown } from "./parse";
import { inlineText, type Block } from "./ast";

export type TocItem = { level: 1 | 2 | 3; text: string; id: string };

/** 소문자·trim·공백→'-'·한글/영숫자/'-'/'_' 외 제거·연속 '-' 축약. 빈 결과는 "section". */
export function slugifyHeading(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{Script=Hangul}a-z0-9_-]/gu, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

/** 중복 슬러그에 -2, -3 … 을 붙인다. 붙인 결과가 다른 슬러그와 겹치면 번호를 더 올린다. */
export function uniqueIds(slugs: readonly string[]): string[] {
  const taken = new Set(slugs);
  const used = new Set<string>();
  return slugs.map((s) => {
    if (!used.has(s)) {
      used.add(s);
      return s;
    }
    let n = 2;
    // 원래 목록에 있는 "a-2" 같은 이름은 그 주인에게 남겨 둔다
    while (used.has(`${s}-${n}`) || taken.has(`${s}-${n}`)) n++;
    const id = `${s}-${n}`;
    used.add(id);
    return id;
  });
}

/** 렌더러와 같은 순서(블록 → 인용·콜아웃 자식 → 리스트 항목 자식)로 헤딩을 모은다. */
function collectHeadings(blocks: Block[], out: Extract<Block, { t: "heading" }>[] = []) {
  for (const b of blocks) {
    switch (b.t) {
      case "heading":
        out.push(b);
        break;
      case "quote":
      case "callout":
        collectHeadings(b.c, out);
        break;
      case "list":
        for (const it of b.items) collectHeadings(it.children, out);
        break;
    }
  }
  return out;
}

/** 헤딩 블록 객체 → id. MarkdownPreview 가 렌더 전에 한 번 계산해 ctx 로 넘긴다. */
export function headingIdMap(blocks: Block[]): Map<Block, string> {
  const hs = collectHeadings(blocks);
  const ids = uniqueIds(hs.map((h) => slugifyHeading(inlineText(h.c))));
  return new Map(hs.map((h, i) => [h, ids[i]]));
}

/** 마크다운 → 목차(h1~h3). 인라인은 평문으로(링크·강조 제거). */
export function extractToc(markdown: string): TocItem[] {
  const { blocks } = parseMarkdown(markdown);
  const ids = headingIdMap(blocks);
  const out: TocItem[] = [];
  for (const h of collectHeadings(blocks)) {
    if (h.level > 3) continue;
    out.push({ level: h.level as 1 | 2 | 3, text: inlineText(h.c).trim(), id: ids.get(h)! });
  }
  return out;
}

/** DOM 에서 모은 헤딩 → 목차. id 가 없으면 슬러그를 주되 이미 있는 id 와 겹치지 않게. */
export function buildTocFromDom(headings: readonly { level: number; text: string; id: string | null }[]): TocItem[] {
  const hs = headings.filter((h) => h.level >= 1 && h.level <= 3);
  const used = new Set(hs.map((h) => h.id).filter((id): id is string => !!id));
  return hs.map((h) => {
    const text = h.text.trim();
    if (h.id) return { level: h.level as 1 | 2 | 3, text, id: h.id };
    const base = slugifyHeading(text);
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return { level: h.level as 1 | 2 | 3, text, id };
  });
}
