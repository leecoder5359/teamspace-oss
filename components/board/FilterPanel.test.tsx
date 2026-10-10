// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { render, cleanup } from "@testing-library/react";
import FilterPanel from "./FilterPanel";

afterEach(cleanup);

describe("FilterPanel 390px 폭", () => {
  it("팝오버 폭이 뷰포트를 넘지 않도록 min()/maxWidth 를 쓰고 규칙 행은 줄바꿈된다", () => {
    const { container } = render(
      <FilterPanel
        properties={[{ id: "p1", name: "이름", type: "text" } as never]}
        filter={{ conj: "and", rules: [{ propId: "p1", op: "contains", value: "a" } as never] }}
        onChange={() => {}}
      />,
    );
    const pop = container.querySelector("details > div") as HTMLElement;
    const style = pop.getAttribute("style") ?? "";
    for (const k of ["position", "left:", "min-width", "max-width"]) expect(style).not.toContain(k);
    const css = readFileSync("app/globals.css", "utf8");
    expect(css).toContain(".ws-filter-pop {");
    expect(css).toMatch(/@media \(max-width: 768px\) \{\s*\.ws-filter-pop \{[^}]*position: fixed[^}]*max-height/);
    expect(pop.classList.contains("ws-filter-pop")).toBe(true);
    expect(container.innerHTML).toContain("flex-wrap: wrap");
  });
});
