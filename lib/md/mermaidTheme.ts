/* mermaid 테마 결정 — 앱 테마(<html data-theme>)가 우선, 없으면 OS 설정(prefers-color-scheme). 순수 함수. */

export type MermaidTheme = "dark" | "default";

export function resolveMermaidTheme(attr: string | null | undefined, prefersDark: boolean): MermaidTheme {
  if (attr === "dark") return "dark";
  if (attr === "light") return "default";
  return prefersDark ? "dark" : "default";
}
