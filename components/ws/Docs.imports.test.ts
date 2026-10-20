import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { moduleImports } from "@/lib/moduleImports";

/* 문서 허브는 한 번에 서피스 하나만 보인다 — 서피스를 정적 import 하면 전부가 /docs 초기 JS 에 실린다(감사 P-5).
   지정자는 TS 파서로 뽑는다(여러 줄 import·re-export·타입 전용 구분). */
const src = readFileSync(new URL("./Docs.tsx", import.meta.url), "utf8");
const imports = moduleImports(src, "Docs.tsx");
const HEAVY = /Surface$|\/DatabaseView$|\/LessonsPage$/;
const SURFACES = ["DatabaseView", "DecisionsSurface", "GlossarySurface", "ChangelogSurface", "RisksSurface", "QaSurface", "DataModelSurface", "DodSurface", "OnboardingSurface", "GraphSurface", "LintSurface"];

describe("Docs.tsx 서피스 지연 로드", () => {
  it("서피스·DatabaseView·LessonsPage 를 정적 import(re-export 포함) 하지 않는다", () => {
    expect(imports.static.filter((p) => HEAVY.test(p))).toEqual([]);
  });

  it("서피스마다 동적 import() 로만 받는다", () => {
    const lazy = imports.dynamic.map((p) => p.split("/").pop());
    for (const name of SURFACES) expect(lazy).toContain(name);
  });

  it("동적 import 는 next/dynamic 으로 감싼다", () => {
    expect(imports.static).toContain("next/dynamic");
  });
});

describe("Docs.tsx 서피스 로딩 자리표시자", () => {
  it("인라인 스타일 없이 DS 클래스(ws-skeleton + ws-skeleton-surface)만 쓴다", () => {
    expect(src).toMatch(/const surfaceLoading = \(\) => <div className="ws-skeleton ws-skeleton-surface" \/>;/);
  });

  it("ws-skeleton-surface 클래스가 saebit.css 에 정의돼 있다", () => {
    const css = readFileSync(new URL("../../app/saebit.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.ws-skeleton-surface\s*\{[^}]*min-height:\s*240px/);
  });
});
