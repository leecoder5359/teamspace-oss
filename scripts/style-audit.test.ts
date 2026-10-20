import { describe, expect, it } from "vitest";
import {
  effectiveDecls,
  findRedundantDecls,
  parseCss,
  parseTokens,
  scanStyleConstants,
  scanTsx,
  tokenEdits,
  unusedClassSelectors,
} from "./style-audit";

const TOKENS = parseTokens(`:root { --ds-fs-md: 13px; --ds-fs-sm: 12px; --ds-r-pill: 999px; --ds-r-sm: 8px; --other: 1px; }`);

describe("parseTokens", () => {
  it("reads only --ds-fs-* and --ds-r-* from :root", () => {
    expect(TOKENS).toEqual({ "--ds-fs-md": "13px", "--ds-fs-sm": "12px", "--ds-r-pill": "999px", "--ds-r-sm": "8px" });
  });
});

describe("scanTsx", () => {
  const scan = (src: string) => scanTsx(src, TOKENS);

  it("normalizes numbers to px and resolves token vars", () => {
    const r = scan(`const a = <div style={{ fontSize: 13, borderRadius: "var(--ds-r-pill)", padding: "9px 12px", color: "var(--x)" }} />;`);
    expect(r.map((e) => [e.prop, e.value, e.style])).toEqual([
      ["fontSize", "13px", true],
      ["borderRadius", "999px", true],
      ["padding", "9px 12px", true],
      ["color", "var(--x)", true],
    ]);
  });

  it("treats CSSProperties-typed constants and nested records as style", () => {
    const r = scan(`const a: CSSProperties = { fontSize: 12 };\nconst b: Record<string, React.CSSProperties> = { x: { fontSize: 11 } };\nconst c = { fontSize: 10 } satisfies CSSProperties;\nfunction f(): CSSProperties { return { fontSize: 9 }; }`);
    expect(r.map((e) => [e.line, e.style])).toEqual([[1, true], [2, true], [3, true], [4, true]]);
  });

  it("treats conditional / spread branches inside style={} as style", () => {
    const r = scan(`const a = <div style={on ? { ...base, fontSize: 13 } : { fontSize: 12 }} />;`);
    expect(r.every((e) => e.style)).toBe(true);
    expect(r).toHaveLength(2);
  });

  it("does not treat untyped non-JSX objects as style (library configs)", () => {
    const r = scan(`const cfg = { fontSize: 13 };\nchart({ fontSize: 12 });`);
    expect(r.every((e) => !e.style)).toBe(true);
  });

  it("marks non-literal values as expressions", () => {
    const r = scan(`const a = <div style={{ fontSize: size * 2 }} />;`);
    expect(r[0].value).toBe("expr:size * 2");
  });
});

describe("tokenEdits", () => {
  it("replaces only exact token values in style contexts", () => {
    const src = `const a = <div style={{ fontSize: 13, borderRadius: 999 }} />;\nconst b: CSSProperties = { fontSize: 12.5, borderRadius: "8px" };\nconst c = { fontSize: 13 };`;
    const { edits, kept } = tokenEdits(src, TOKENS);
    expect(edits.map((e) => [e.line, e.prop, e.to])).toEqual([
      [1, "fontSize", `"var(--ds-fs-md)"`],
      [1, "borderRadius", `"var(--ds-r-pill)"`],
      [2, "borderRadius", `"var(--ds-r-sm)"`],
    ]);
    expect(kept.map((k) => [k.prop, k.value])).toEqual([["fontSize", "12.5px"]]);
  });

  it("leaves multi-value radius strings alone", () => {
    const { edits } = tokenEdits(`const a = <div style={{ borderRadius: "8px 8px 0 0" }} />;`, TOKENS);
    expect(edits).toEqual([]);
  });
});

describe("scanStyleConstants", () => {
  it("lists top-level style constants with their full normalized property map", () => {
    const r = scanStyleConstants(`export const inputStyle: CSSProperties = { width: "100%", fontSize: 13, fontWeight: 600 };\nconst other = 1;`, TOKENS);
    expect(r).toEqual({ inputStyle: { width: "100%", fontSize: "13px", fontWeight: "600" } });
  });

  it("inlines spreads of earlier constants in the same file, later keys win", () => {
    const r = scanStyleConstants(`const a: CSSProperties = { fontSize: 13, color: "red" };\nconst b: CSSProperties = { ...a, fontSize: 16 };\nconst c: CSSProperties = { ...other };`, TOKENS);
    expect(r.b).toEqual({ fontSize: "16px", color: "red" });
    expect(r.c).toEqual({ "...other": "spread" });
  });
});

describe("parseCss", () => {
  it("splits selector lists, keeps at-rule context and skips comments", () => {
    const r = parseCss(`/* a { x: 1 } */\n.a, .b:not(.c, .d) { color: red; padding: 1px !important; }\n@media (max-width: 768px) {\n  .a { color: blue; }\n}`);
    expect(r.map((x) => [x.selectors, x.context, x.decls])).toEqual([
      [[".a", ".b:not(.c, .d)"], "", [{ prop: "color", value: "red", important: false }, { prop: "padding", value: "1px", important: true }]],
      [[".a"], "@media (max-width: 768px)", [{ prop: "color", value: "blue", important: false }]],
    ]);
    expect(r[1].line).toBe(4);
  });
});

describe("findRedundantDecls", () => {
  const legacy = parseCss(`.a { color: red; padding: 1px; }\n@media (max-width: 768px) { .a { z-index: 30; top: 1px; } }\n.b { color: red !important; }`);
  const later = parseCss(`.a { color: blue; }\n@media (max-width: 768px) { .a { z-index: 60; } }\n@media (min-width: 1px) { .a { padding: 2px; } }\n.b { color: blue; }`);

  it("finds decls overridden by the same selector in the same or unconditional context", () => {
    const r = findRedundantDecls(legacy, later);
    expect(r.map((x) => [x.selector, x.context, x.prop])).toEqual([
      [".a", "", "color"],
      [".a", "@media (max-width: 768px)", "z-index"],
    ]);
  });

  it("counts a later rule in the same file, and padding longhands covered by the shorthand", () => {
    const own = parseCss(`.a { padding-left: 1px; }\n.a { padding: 2px; }`);
    expect(findRedundantDecls(own, []).map((x) => x.prop)).toEqual(["padding-left"]);
  });
});

describe("effectiveDecls", () => {
  it("folds unconditional rules into conditional contexts, last wins", () => {
    const r = effectiveDecls(parseCss(`@media (x) { .a { color: red; top: 1px; } }\n.a { color: blue; }`));
    expect(r["@media (x) | .a"]).toEqual({ color: "blue", top: "1px" });
    expect(r[" | .a"]).toEqual({ color: "blue" });
  });
});

describe("unusedClassSelectors", () => {
  it("flags ws-* selectors whose class never appears in sources, ignoring :not()", () => {
    const rules = parseCss(`.ws-a .ws-b { x: 1 }\n.ws-a { x: 1 }\n.ws-a:not(.ws-zzz) { x: 1 }\n.bn-x { x: 1 }`);
    const r = unusedClassSelectors(rules, [`<div className="ws-a" />`]);
    expect(r.map((x) => [x.selector, x.missing])).toEqual([[".ws-a .ws-b", ["ws-b"]]]);
  });

  it("treats a template prefix as a possible usage", () => {
    const rules = parseCss(`.ws-row--muted { x: 1 }`);
    expect(unusedClassSelectors(rules, ["className={`ws-row--${tone}`}"])).toEqual([]);
  });
});
