/**
 * PURE helper for the Phase 3 dogfood seed.
 *
 * Extracts the top-level HIGH-priority backlog item titles from a backlog
 * markdown file such as `docs/teamspace/BACKLOG-LLM위키-기능갭.md`.
 *
 * Rules:
 *   - Only the "## 높음" section is considered (from the "## 높음" heading
 *     until the next "## " heading).
 *   - Only top-level (non-indented) checkbox items shaped like
 *       "- [ ] **<title>**"  (or "- [x] **<title>**")
 *     are collected. Indented sub-bullets are ignored.
 *   - The captured bold title is cleaned:
 *       - a leading list number ("1. ") is removed,
 *       - backticks (`) are stripped,
 *       - surrounding whitespace is trimmed.
 *
 * No IO, no side effects — TDD-verified in scripts/parseBacklog.test.ts.
 */
export function parseBacklogTitles(md: string): string[] {
  const lines = md.split(/\r?\n/);
  const titles: string[] = [];
  let inHigh = false;

  for (const line of lines) {
    // Any "##" (or deeper) heading toggles section context.
    const heading = line.match(/^#{2,}\s+(.*)$/);
    if (heading) {
      inHigh = /높음/.test(heading[1]);
      continue;
    }
    if (!inHigh) continue;

    // Top-level checkbox item only (no leading indentation).
    const m = line.match(/^- \[[ xX]\]\s+\*\*(.+?)\*\*/);
    if (!m) continue;

    let title = m[1];
    title = title.replace(/^\d+\.\s*/, ""); // drop leading "1. "
    title = title.replace(/`/g, ""); // drop backticks
    title = title.trim();
    if (title) titles.push(title);
  }

  return titles;
}
