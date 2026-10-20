import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// U-25: 모션 감소 설정이면 드로어 등장 애니메이션·사이드바 슬라이드도 끈다.
const css = fs.readFileSync(path.join(__dirname, "saebit.css"), "utf8");
const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
const rule = (sel: string) => reduced.match(new RegExp(`(^|\\n)\\s*${sel.replace(".", "\\.")}\\s*\\{([^}]*)\\}`))?.[2] ?? "";

describe("saebit.css prefers-reduced-motion", () => {
  it("드로어 애니메이션을 끈다", () => {
    expect(rule(".ws-drawer")).toMatch(/animation:\s*none/);
  });
  it("사이드바 트랜지션을 끈다", () => {
    expect(rule(".ws-sidebar")).toMatch(/transition:\s*none/);
  });
  it("기존 스켈레톤 규칙은 그대로다", () => {
    expect(rule(".ws-skeleton")).toMatch(/animation:\s*none/);
  });
});
