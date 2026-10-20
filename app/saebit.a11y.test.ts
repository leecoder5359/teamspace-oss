import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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

  it("인라인 스타일 입력·select 용 .ws-focus-ring 도 같은 DS 테두리+링을 받는다(인라인 테두리를 이기도록 !important)", () => {
    expect(css).toMatch(/\.ws-focus-ring:focus, \.ws-search:focus-within \{ outline: none; border-color: var\(--ds-primary\);/);
    expect(css).toMatch(/\.ws-focus-ring:focus \{ border-color: var\(--ds-primary\) !important; \}/);
  });

  it("검색 입력 상자는 포커스 시 DS 테두리+링을 받는다", () => {
    expect(css).toMatch(/\.ws-search:focus-within \{ outline: none; border-color: var\(--ds-primary\); box-shadow: 0 0 0 3px var\(--ds-primary-weak\);/);
  });
});

describe("saebit.css 비대화형 표시(U-12 후속)", () => {
  it(".ws-company 는 hover 배경이 없고 커서가 기본이다(클릭할 수 있어 보이지 않게)", () => {
    expect(css.includes(".ws-company:hover")).toBe(false);
    expect(css.match(/\.ws-company \{[^}]*\}/)?.[0]).toContain("cursor: default;");
  });
});

describe("인라인 outline:none 금지(U-8)", () => {
  // 인라인으로 포커스 표시를 지우면 대체 링이 없다 — 지우지 말고 .ws-focus-ring 을 붙인다(focus 때만 outline 을 끄고 DS 링을 그린다).
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const tsx = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return name === "generated" ? [] : tsx(p);
      return name.endsWith(".tsx") && !name.includes(".test.") ? [p] : [];
    });

  it("components·app 의 tsx 에 인라인 outline: \"none\" 이 없다", () => {
    const hits = [...tsx(join(repo, "components")), ...tsx(join(repo, "app"))]
      .filter((p) => /outline:\s*["']none["']/.test(readFileSync(p, "utf8")))
      .map((p) => p.slice(repo.length));
    expect(hits).toEqual([]);
  });
});
