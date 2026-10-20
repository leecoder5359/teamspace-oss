import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// globals.css 는 saebit.css 가 같은 선택자로 덮는다는 전제로 정리됐다(U-23) — 순서가 바뀌면 레거시 값이 다시 이긴다.
const layout = readFileSync(fileURLToPath(new URL("./layout.tsx", import.meta.url)), "utf8");
const cssImports = [...layout.matchAll(/^import\s+["']([^"']+\.css)["'];?\s*$/gm)].map((m) => m[1]);

describe("app/layout.tsx CSS import order", () => {
  it("imports globals.css then saebit.css with no CSS import between", () => {
    const g = cssImports.indexOf("./globals.css");
    expect(g).toBeGreaterThanOrEqual(0);
    expect(cssImports[g + 1]).toBe("./saebit.css");
  });
});
