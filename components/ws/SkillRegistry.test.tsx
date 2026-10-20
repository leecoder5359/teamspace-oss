// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import SkillRegistry from "./SkillRegistry";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const copy = { id: "c1", path: "/x/SKILL.md", name: "deploy", description: null, lines: 10, mtime: "2026-10-01T00:00:00Z", kind: "repo", scope: "global", repo: null, branch: null, checkout: null, status: "canonical" };
const data = {
  configured: true,
  scannedAt: "2026-10-20T00:00:00Z",
  scan: { truncated: false, truncatedReason: null, durationMs: 1, dirsVisited: 1, errors: 0, maxDepth: 3, roots: [] },
  summary: { groups: 1, copies: 1, staleCopies: 0, groupsWithStale: 0, differingCopies: 0 },
  groups: [{ key: "g1", name: "deploy", scope: "global", canonicalId: "c1", copies: [copy], distinct: 1, stale: 0, differs: 1 }],
};
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => json(data))));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SkillRegistry 그룹 행 키보드(U-4)", () => {
  it("행에서 Enter 로 펼치고 접는다", async () => {
    render(<SkillRegistry />);
    const tr = (await screen.findByText("deploy")).closest("tr")!;
    expect(tr.getAttribute("role")).toBe("button");
    expect(tr.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(tr, { key: "Enter" });
    expect(tr.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(tr, { key: " " });
    expect(tr.getAttribute("aria-expanded")).toBe("false");
  });
});
