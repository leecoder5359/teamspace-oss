import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/* 문서 허브는 한 번에 서피스 하나만 보인다 — 서피스를 정적 import 하면 전부가 /docs 초기 JS 에 실린다(감사 P-5). */
const src = readFileSync(new URL("./Docs.tsx", import.meta.url), "utf8");
const staticImports = [...src.matchAll(/^import\s+[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);

describe("Docs.tsx 서피스 지연 로드", () => {
  it("서피스·DatabaseView·LessonsPage 를 정적 import 하지 않는다", () => {
    const heavy = staticImports.filter((p) => /Surface$|\/DatabaseView$|\/LessonsPage$/.test(p));
    expect(heavy).toEqual([]);
  });

  it("서피스마다 next/dynamic 으로 감싼다", () => {
    for (const name of ["DatabaseView", "DecisionsSurface", "GlossarySurface", "ChangelogSurface", "RisksSurface", "QaSurface", "DataModelSurface", "DodSurface", "OnboardingSurface", "GraphSurface", "LintSurface"]) {
      expect(src).toMatch(new RegExp(`const ${name} = dynamic\\(`));
    }
  });
});
