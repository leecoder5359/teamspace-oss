// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/useAutoRefresh", () => ({ useAutoRefresh: () => {} }));
const pages = vi.hoisted(() => ({ list: [] as { id: string; kind: string }[] }));
vi.mock("@/lib/pagesClient", () => ({ getPages: async () => ({ ok: true, data: { pages: pages.list } }) }));

import Dashboard from "./Dashboard";

afterEach(() => {
  pages.list = [];
  cleanup();
  vi.unstubAllGlobals();
});

describe("Dashboard — 화면 제목(U-29)", () => {
  it("인사말이 화면의 유일한 <h1>", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const { container } = render(<Dashboard userName="테스터" />);
    await screen.findByText("아직 태스크가 없어요");
    const h1s = container.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe("안녕하세요, 테스터님");
  });
});

describe("Dashboard — 서버 집계 통계(P-8)", () => {
  it("보드 전체가 아니라 /api/databases/<id>/stats 를 받아 그린다", async () => {
    pages.list = [{ id: "b1", kind: "database" }];
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const stats = {
      total: 5,
      status: { buckets: [{ id: "a", name: "할 일", color: "gray", count: 3 }, { id: "z", name: "끝남", color: "green", count: 2 }], unset: 0, inProgress: null, done: { name: "끝남", count: 2 } },
      second: null,
      assignees: [{ name: "민수", count: 3 }],
      dueOpen: [{ id: "r1", title: "오늘 할 일", due: key, assignee: "민수" }],
    };
    const fetchMock = vi.fn(async (url: string) =>
      url === "/api/databases/b1/stats" ? Response.json({ page: { id: "b1", title: "태스크" }, stats }) : new Response("{}", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<Dashboard userName="테스터" />);
    await screen.findByText("오늘 할 일");
    expect(screen.getByText("오늘 마감 1건, 이번 주 마감 1건, 지연 0건이 있어요.")).toBeTruthy();
    expect(screen.getAllByText("끝남").length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.map((c) => c[0])).not.toContain("/api/databases/b1");
  });
});
