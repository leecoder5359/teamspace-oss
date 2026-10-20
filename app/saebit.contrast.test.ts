import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// U-9: 본문으로 쓰는 보조 글자색이 WCAG AA(4.5:1)를 지키는지 saebit.css 토큰 값 그대로 계산한다.
const css = readFileSync(fileURLToPath(new URL("./saebit.css", import.meta.url)), "utf8");

function block(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no block: ${selector}`);
  return css.slice(start, css.indexOf("\n}", start));
}

// var(--x) 는 같은 블록 → 라이트 블록 순으로 따라가 #RRGGBB 로 푼다.
function tokens(theme: "light" | "dark") {
  const light = block(":root,\n:root[data-theme=\"light\"]");
  const scopes = theme === "dark" ? [block(":root[data-theme=\"dark\"]"), light] : [light];
  const raw = (name: string) => {
    for (const s of scopes) {
      const m = s.match(new RegExp(`--${name}:\\s*([^;]+);`));
      if (m) return m[1].trim();
    }
    throw new Error(`no token: --${name}`);
  };
  const resolve = (name: string): string => {
    const v = raw(name);
    const ref = v.match(/^var\(--([\w-]+)\)$/);
    return ref ? resolve(ref[1]) : v;
  };
  return resolve;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("saebit.css text contrast (WCAG AA 4.5:1)", () => {
  it("light --text-muted reads on card and page surfaces", () => {
    const t = tokens("light");
    expect(contrast(t("text-muted"), t("surface-card"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t("text-muted"), t("surface-page"))).toBeGreaterThanOrEqual(4.5);
  });

  it("dark --text-muted reads on card and hover surfaces", () => {
    const t = tokens("dark");
    expect(contrast(t("text-muted"), t("surface-card"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t("text-muted"), t("surface-hover"))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["light", "dark"] as const)("%s --color-warning-text reads on card, page and warning-weak", (theme) => {
    const t = tokens(theme);
    for (const bg of ["surface-card", "surface-page", "color-warning-weak"]) {
      expect(contrast(t("color-warning-text"), t(bg))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(["light", "dark"] as const)("%s --text-sub 는 AA 이고 --text-muted 보다 대비가 높다(위계 유지)", (theme) => {
    const t = tokens(theme);
    const surfaces = theme === "light" ? ["surface-card", "surface-page", "surface-sunken"] : ["surface-card", "surface-page", "surface-hover"];
    for (const bg of surfaces) {
      expect(contrast(t("text-sub"), t(bg))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t("text-sub"), t(bg))).toBeGreaterThan(contrast(t("text-muted"), t(bg)));
    }
  });
});
