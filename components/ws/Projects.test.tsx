// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import Projects from "./Projects";
import type { ProjectStat } from "@/lib/projects";

const stat = (id: string, name: string, archivedAt: string | null = null): ProjectStat => ({
  id, name, short: null, color: "blue", description: null, repoUrl: null, repoPath: null, repoBranch: null, docsDir: null,
  archivedAt, lead: null, boardPageId: null, taskCount: 0, openCount: 0, doneCount: 0, overdueCount: 0, dueSoonCount: 0,
  statusBuckets: [], participants: [], docCount: 0,
});

const active = stat("p1", "활성 프로젝트");
const archived = stat("p2", "보관 프로젝트", "2026-10-01T00:00:00.000Z");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Projects — 보관", () => {
  it("기본은 활성만 보이고, '보관 포함' 을 켜면 ?archived=all 로 다시 읽어 보관 카드(보관됨 배지·해제 버튼)가 나온다", async () => {
    const fetchMock = vi.fn(async (url: string) => ({ ok: url.includes("archived=all"), json: async () => ({ projects: [active, archived] }) }));
    vi.stubGlobal("fetch", fetchMock);
    render(<Projects initialProjects={[active]} members={[]} />);

    expect(screen.getByText("활성 프로젝트")).toBeTruthy();
    expect(screen.queryByText("보관 프로젝트")).toBeNull();
    // 활성 카드에는 '보관' 버튼
    expect(screen.getByRole("button", { name: "보관" })).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: /보관 포함/ }));
    await waitFor(() => expect(screen.getByText("보관 프로젝트")).toBeTruthy());
    expect(String(fetchMock.mock.calls[0][0])).toContain("archived=all");
    expect(screen.getByText("보관됨")).toBeTruthy();
    expect(screen.getByRole("button", { name: "해제" })).toBeTruthy();
    expect(screen.getByText("활성 1 · 보관 1")).toBeTruthy();
  });

  it("보관 버튼은 PATCH {archived:true} 를 보내고 목록을 다시 읽는다", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      json: async () => (init?.method === "PATCH" ? {} : { projects: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<Projects initialProjects={[active]} members={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "보관" }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/projects/p1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ archived: true });
  });
});
