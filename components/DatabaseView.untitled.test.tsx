// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { DbPayload } from "./board/useBoardData";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("./ws/PresenceBar", () => ({ default: () => null }));
vi.mock("./ws/SharePanel", () => ({ default: () => null }));
vi.mock("./Breadcrumb", () => ({ default: () => null }));

import DatabaseView from "./DatabaseView";

const payload: DbPayload = {
  page: { id: "db1", title: "", kind: "database", project: null },
  properties: [{ id: "t", name: "제목", type: "text", config: null, position: 0 }],
  views: [{ id: "v1", name: "표", type: "table", config: null, position: 0 }],
  rows: [],
};
const json = (body: unknown, s = 200) => new Response(JSON.stringify(body), { status: s, headers: { "content-type": "application/json" } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DatabaseView 제목 폴백(U-28)", () => {
  it("제목이 비면 영문 Untitled 대신 '제목 없음'을 화면 제목(h1)으로 보인다", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/databases/db1") return json(payload);
      if (url.startsWith("/api/schedules")) return json({ schedules: [] });
      if (url.startsWith("/api/projects")) return json({ projects: [] });
      return json({}, 404);
    }));
    render(<DatabaseView pageId="db1" />);
    expect(await screen.findByRole("heading", { level: 1, name: "제목 없음" })).toBeTruthy();
    expect(screen.queryByText("Untitled")).toBeNull();
  });
});
