// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { DbPayload } from "./board/useBoardData";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("./ws/PresenceBar", () => ({ default: () => null }));
vi.mock("./ws/SharePanel", () => ({ default: () => null }));
vi.mock("./Breadcrumb", () => ({ default: () => null }));
vi.mock("./ws/TaskDetail", () => ({ default: ({ row }: { row: { id: string } }) => <div data-testid="detail">{row.id}</div> }));

import DatabaseView from "./DatabaseView";

const status = {
  id: "s", name: "상태", type: "select" as const, position: 1,
  config: { options: [{ id: "o1", name: "진행중", color: "blue" }] },
};
const payload: DbPayload = {
  page: { id: "db1", title: "보드", kind: "database", project: null },
  properties: [{ id: "t", name: "제목", type: "text", config: null, position: 0 }, status],
  views: [{ id: "v1", name: "칸반", type: "kanban", config: { groupBy: "s" }, position: 0 }],
  rows: [{ id: "a", props: { t: "카드 a", s: "o1" }, position: 0 }],
};
const json = (body: unknown, s = 200) =>
  new Response(JSON.stringify(body), { status: s, headers: { "content-type": "application/json" } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("칸반 카드 키보드로 열기(U-4)", () => {
  it.each(["Enter", " "])("포커스한 카드에서 %j 키로 상세를 연다", async (key) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/databases/db1") return json(payload);
        if (url.startsWith("/api/schedules")) return json({ schedules: [] });
        if (url.startsWith("/api/projects")) return json({ projects: [] });
        return json({}, 404);
      }),
    );
    render(<DatabaseView pageId="db1" />);
    const card = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".ws-kanban-card");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(card.getAttribute("role")).toBe("button");
    expect(card.tabIndex).toBe(0);
    fireEvent.keyDown(card, { key });
    expect((await screen.findByTestId("detail")).textContent).toBe("a");
  });
});
