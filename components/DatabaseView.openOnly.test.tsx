// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import type { DbPayload } from "./board/useBoardData";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("./ws/PresenceBar", () => ({ default: () => null }));
vi.mock("./ws/SharePanel", () => ({ default: () => null }));
vi.mock("./Breadcrumb", () => ({ default: () => null }));

import DatabaseView from "./DatabaseView";

const status = {
  id: "s", name: "상태", type: "select" as const, position: 1,
  config: { options: [{ id: "o1", name: "진행중", color: "blue" }, { id: "o2", name: "완료", color: "green" }] },
};
const payload: DbPayload = {
  page: { id: "db1", title: "보드", kind: "database", project: null },
  properties: [{ id: "t", name: "제목", type: "text", config: null, position: 0 }, status],
  views: [{ id: "v1", name: "표", type: "table", config: null, position: 0 }],
  rows: [
    { id: "a", props: { t: "행 a", s: "o1" }, position: 0, updatedAt: "2026-01-01" },
    { id: "a1", props: { t: "행 a1", s: "o1" }, position: 1, updatedAt: "2026-09-01", parentRowId: "a" },
    { id: "b", props: { t: "행 b", s: "o1" }, position: 2, updatedAt: "2026-05-01" },
    { id: "c", props: { t: "행 c", s: "o2" }, position: 3, updatedAt: "2026-07-01" },
  ],
};

const json = (body: unknown, s = 200) =>
  new Response(JSON.stringify(body), { status: s, headers: { "content-type": "application/json" } });

function setup() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/databases/db1") return json(payload);
      if (url.startsWith("/api/schedules")) return json({ schedules: [] });
      if (url.startsWith("/api/projects")) return json({ projects: [] });
      if (url.startsWith("/api/rows/") && init?.method === "PATCH") return json({ ok: true });
      return json({}, 404);
    }),
  );
  return render(<DatabaseView pageId="db1" />);
}

/** tbody 행의 제목 입력값 순서 */
const order = () =>
  [...document.querySelectorAll("tbody tr.ws-table-row")].map(
    (tr) => (tr.querySelector("input") as HTMLInputElement | null)?.value,
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("DatabaseView 열린 것만 (2A 후속)", () => {
  it("뷰 정렬이 없으면 최상위는 수정 시각 내림차순, 서브아이템은 부모 아래에 남는다", async () => {
    setup();
    await waitFor(() => expect(order()).toEqual(["행 b", "행 a", "행 a1"]));
  });

  it("초기화 (n/m) 의 n 은 표에 실제로 보이는 행 수다(열린 것만 적용 후)", async () => {
    setup();
    await waitFor(() => expect(order()).toHaveLength(3));
    fireEvent.change(screen.getByPlaceholderText("검색…"), { target: { value: "행" } });
    expect(screen.getByRole("button", { name: "초기화 (3/4)" })).toBeTruthy();
  });

  it("완료로 바꾼 행은 바로 사라지지 않고 흐리게 남는다 — 검색을 바꾸면 숨겨진다", async () => {
    setup();
    await waitFor(() => expect(order()).toHaveLength(3));
    const rowB = [...document.querySelectorAll("tbody tr.ws-table-row")].find(
      (tr) => (tr.querySelector("input") as HTMLInputElement).value === "행 b",
    )!;
    fireEvent.change(within(rowB as HTMLElement).getByLabelText("상태"), { target: { value: "o2" } });
    await waitFor(() => expect(document.querySelector("tr[data-kept]")).not.toBeNull());
    expect(order()).toEqual(["행 b", "행 a", "행 a1"]);
    expect(screen.getByText("완료·취소 1건 숨김")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText("검색…"), { target: { value: "행" } });
    expect(order()).toEqual(["행 a", "행 a1"]);
    expect(document.querySelector("tr[data-kept]")).toBeNull();
    expect(screen.getByText("완료·취소 2건 숨김")).toBeTruthy();
  });

  it("상태가 아닌 속성(제목)을 고친 행은 남겨 두지 않는다", async () => {
    setup();
    await waitFor(() => expect(order()).toHaveLength(3));
    const rowB = [...document.querySelectorAll("tbody tr.ws-table-row")].find(
      (tr) => (tr.querySelector("input") as HTMLInputElement).value === "행 b",
    )!;
    const input = rowB.querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "행 b2" } });
    fireEvent.blur(input);
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector("tr[data-kept]")).toBeNull();
  });

  it("남겨 둔 행의 툴팁은 상태 변경 기준으로 안내한다", async () => {
    setup();
    await waitFor(() => expect(order()).toHaveLength(3));
    const rowB = [...document.querySelectorAll("tbody tr.ws-table-row")].find(
      (tr) => (tr.querySelector("input") as HTMLInputElement).value === "행 b",
    )!;
    fireEvent.change(within(rowB as HTMLElement).getByLabelText("상태"), { target: { value: "o2" } });
    await waitFor(() => expect(document.querySelector("tr[data-kept]")).not.toBeNull());
    expect(document.querySelector("tr[data-kept]")!.getAttribute("title")).toContain("방금 상태를 바꾼 행");
  });
});
