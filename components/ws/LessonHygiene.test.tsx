// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, waitFor, fireEvent } from "@testing-library/react";
import LessonHygiene from "./LessonHygiene";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const counts = { merges: 0, drops: 0, review: 0, required: 0, ondemand: 0, scopeFixes: 0 };
const run = (id: string, weekKey: string) => ({ id, weekKey, status: "proposed", summary: "", counts, appliedAt: null, revertedAt: null, createdAt: "2026-10-19T00:00:00Z" });
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LessonHygiene 실행 기록 행 키보드(U-4)", () => {
  it("행에서 Enter 로 그 실행을 고른다", async () => {
    fetchMock.mockImplementation(async (u: string) =>
      u.startsWith("/api/lessons/hygiene?") ? json({ runs: [run("r1", "2026-W42"), run("r2", "2026-W41")] }) : json({}, 404),
    );
    render(<LessonHygiene isAdmin={false} />);
    const tr = (await screen.findByText("2026-W41")).closest("tr")!;
    expect(tr.getAttribute("role")).toBe("button");
    expect(tr.tabIndex).toBe(0);
    fireEvent.keyDown(tr, { key: "Enter" });
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === "/api/lessons/hygiene/r2")).toBe(true));
  });
});
