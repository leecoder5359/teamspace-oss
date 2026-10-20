import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 키보드·터치 접근성을 받치는 CSS 규칙이 지워지지 않게 지킨다(UX 감사 U-7·U-8).
const css = readFileSync(fileURLToPath(new URL("./saebit.css", import.meta.url)), "utf8").replace(/\s+/g, " ");

/** `@media (...)` 블록 본문을 돌려준다(중첩 없는 블록 전제). */
function mediaBlock(query: string): string {
  const start = css.indexOf(`@media ${query}`);
  if (start < 0) return "";
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  return "";
}

describe("saebit.css 접근성 규칙", () => {
  it("트리 행 동작 버튼은 키보드 포커스(focus-within)에서도 보인다", () => {
    expect(css).toMatch(/\.ws-tree-row:focus-within \.ws-row-actions[^{]*\{ opacity: 1;/);
  });

  it("터치 기기(hover:none)에서는 트리 행 동작 버튼이 항상 보인다", () => {
    expect(mediaBlock("(hover: none) and (pointer: coarse)")).toMatch(/\.ws-row-actions \{ opacity: 1;/);
  });

  it("검색 입력 상자는 포커스 시 DS 테두리+링을 받는다", () => {
    expect(css).toMatch(/\.ws-search:focus-within \{ outline: none; border-color: var\(--ds-primary\); box-shadow: 0 0 0 3px var\(--ds-primary-weak\);/);
  });
});
