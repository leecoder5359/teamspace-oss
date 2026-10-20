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
    const open = await screen.findByRole("button", { name: "카드 a" });
    expect(open.tabIndex).toBe(0);
    fireEvent.keyDown(open, { key });
    expect((await screen.findByTestId("detail")).textContent).toBe("a");
  });
});

describe("칸반 카드 구조 — 중첩 인터랙티브 없음(U-31)", () => {
  it("⋯ 메뉴 버튼은 카드 열기 버튼(role=button)의 자손이 아니고, 카드 클릭은 상세를 연다", async () => {
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
    const trigger = await screen.findByRole("button", { name: "카드 메뉴: 카드 a" });
    expect(trigger.parentElement?.closest('[role="button"]')).toBeNull();
    const card = trigger.closest<HTMLElement>(".ws-kanban-card")!;
    expect(card.getAttribute("role")).toBeNull();
    fireEvent.click(trigger);
    expect(screen.queryByTestId("detail")).toBeNull();
    fireEvent.click(screen.getByText("카드 a"));
    expect((await screen.findByTestId("detail")).textContent).toBe("a");
  });
});

describe("칸반 카드 메뉴로 칸 옮기기(U-31)", () => {
  const two = {
    ...payload,
    properties: [payload.properties[0], { ...status, config: { options: [...status.config.options, { id: "o2", name: "완료", color: "green" }] } }],
  };
  const patches: { url: string; body: unknown }[] = [];
  const stub = (patchStatus: number) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "PATCH") {
          patches.push({ url, body: JSON.parse(String(init.body)) });
          return json(patchStatus === 200 ? {} : { error: "권한이 없습니다" }, patchStatus);
        }
        if (url === "/api/databases/db1") return json(two);
        if (url.startsWith("/api/schedules")) return json({ schedules: [] });
        if (url.startsWith("/api/projects")) return json({ projects: [] });
        return json({}, 404);
      }),
    );
  const colOf = (el: HTMLElement) => el.closest(".ws-kanban-col")?.querySelector(".ws-kanban-col-head span:nth-child(2)")?.textContent;

  it("메뉴에서 고른 칸으로 드래그와 같은 경로(PATCH)로 옮기고, 상세는 열지 않는다", async () => {
    patches.length = 0;
    stub(200);
    render(<DatabaseView pageId="db1" />);
    fireEvent.click(await screen.findByRole("button", { name: "카드 메뉴: 카드 a" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "완료" }));
    await waitFor(() => expect(patches).toEqual([{ url: "/api/rows/a", body: { props: { s: "o2" } } }]));
    expect(colOf(screen.getByText("카드 a"))).toBe("완료");
    expect(screen.queryByTestId("detail")).toBeNull();
    // 카드가 새 칸에서 다시 그려져도 포커스는 body 로 떨어지지 않고 옮겨진 카드의 ⋯ 로 간다
    await waitFor(() => {
      const t = screen.getByRole("button", { name: "카드 메뉴: 카드 a" });
      expect(document.activeElement).toBe(t);
      expect(colOf(t)).toBe("완료");
    });
  });

  it("저장이 실패하면 원래 칸으로 되돌린다", async () => {
    patches.length = 0;
    stub(500);
    render(<DatabaseView pageId="db1" />);
    fireEvent.click(await screen.findByRole("button", { name: "카드 메뉴: 카드 a" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "완료" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    await waitFor(() => expect(colOf(screen.getByText("카드 a"))).toBe("진행중"));
    expect(await screen.findByText("권한이 없습니다")).toBeTruthy(); // 드래그 실패와 같은 오류 배너
    // 되돌린 뒤에도 원래 칸의 카드 ⋯ 에 포커스가 있다
    await waitFor(() => {
      const t = screen.getByRole("button", { name: "카드 메뉴: 카드 a" });
      expect(document.activeElement).toBe(t);
      expect(colOf(t)).toBe("진행중");
    });
  });
});
