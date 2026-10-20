import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 화면마다 탭 제목이 있어야 한다(U-16) — 모든 탭이 "TeamSpace" 로만 보이지 않게.
// 루트(/) 는 첫 문서로 보내는 리다이렉트, /p/[id] 는 generateMetadata 로 문서 제목을 쓴다.
const root = fileURLToPath(new URL(".", import.meta.url));
function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return pages(p);
    return name === "page.tsx" ? [p] : [];
  });
}

describe("(ws) 화면 탭 제목", () => {
  it("모든 화면이 metadata.title 또는 generateMetadata 를 내보낸다", () => {
    const missing = pages(root)
      .filter((p) => p !== join(root, "page.tsx"))
      .filter((p) => !/export const metadata: Metadata = \{ title: "[^"]+" \}|export async function generateMetadata/.test(readFileSync(p, "utf8")))
      .map((p) => p.slice(root.length));
    expect(missing).toEqual([]);
  });
});
