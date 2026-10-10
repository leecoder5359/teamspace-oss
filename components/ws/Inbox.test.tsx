// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, fireEvent, cleanup, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
let autoRefresh: (() => unknown) | null = null;
vi.mock("@/lib/useAutoRefresh", () => ({ useAutoRefresh: (fn: () => unknown) => { autoRefresh = fn; } }));

import Inbox from "./Inbox";

const fetchMock = vi.fn();

describe("Inbox — 종류 칩", { timeout: 15_000 }, () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ notifications: [], unread: 7, byType: { approval: 4, mention: 3 } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("전체·승인·배정·멘션·마감·제안·공유 칩과 미읽음 배지를 보인다", async () => {
    render(<Inbox />);
    await waitFor(() => expect(screen.getByRole("button", { name: /승인/ }).textContent).toContain("4"));
    for (const l of ["전체", "승인", "배정", "멘션", "마감", "제안", "공유"]) expect(screen.getByRole("button", { name: new RegExp(l) })).toBeTruthy();
    // 댓글 알림은 mention 으로 쌓인다 — 늘 비는 댓글 칩은 없다
    expect(screen.queryByRole("button", { name: /댓글/ })).toBeNull();
    expect(screen.getByRole("button", { name: /전체/ }).textContent).toContain("7");
    expect(screen.getByRole("button", { name: /멘션/ }).textContent).toContain("3");
    // 미읽음 0 이면 배지 없음
    expect(screen.getByRole("button", { name: /배정/ }).querySelector(".ws-nav-count")).toBeNull();
  });

  it("칩 선택 시 ?type= 으로 재조회, 전체는 필터 없이", async () => {
    render(<Inbox />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("type=");
    fireEvent.click(screen.getByRole("button", { name: /승인/ }));
    await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)![0])).toContain("type=approval"));
    expect(screen.getByRole("button", { name: /승인/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /전체/ }));
    await waitFor(() => expect(String(fetchMock.mock.calls.at(-1)![0])).not.toContain("type="));
  });
  it("늦게 도착한 이전 요청 응답이 칩 변경 후 목록을 덮지 않는다", async () => {
    const notif = (id: string, type: string, title: string) => ({ id, type, title, link: null, readAt: null, createdAt: "2026-10-01T00:00:00Z" });
    let releaseFirst!: () => void;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
      if (!String(url).includes("type=")) {
        // 첫 요청(전체)은 칩 변경 뒤에야 끝난다
        await new Promise<void>((res) => (releaseFirst = res));
        return { ok: true, json: async () => ({ notifications: [notif("a", "mention", "옛 전체 목록")], unread: 2, byType: {} }) };
      }
      return { ok: true, json: async () => ({ notifications: [notif("b", "approval", "승인 알림")], unread: 2, byType: { approval: 1 } }) };
    });
    render(<Inbox />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /승인/ }));
    await waitFor(() => expect(screen.getByText("승인 알림")).toBeTruthy());
    releaseFirst();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("옛 전체 목록")).toBeNull();
    expect(screen.getByText("승인 알림")).toBeTruthy();
  });

  it("묶음 펼침은 갱신으로 새 알림이 합류해도 유지된다(가장 오래된 id 로 키)", async () => {
    const notif = (id: string, at: string) => ({ id, type: "mention", title: `알림 ${id}`, link: "/x", readAt: null, createdAt: at });
    let rows = [notif("b", "2026-10-09T01:00:00Z"), notif("a", "2026-10-09T00:00:00Z")];
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ notifications: rows, unread: rows.length, byType: {} }) }));
    try { localStorage.setItem("ws.inbox.group", "1"); } catch { /* noop */ }
    render(<Inbox />);
    await waitFor(() => expect(screen.getAllByText(/알림 b/).length).toBeGreaterThan(0));
    if (screen.getByRole("button", { name: "묶어 보기" }).getAttribute("aria-pressed") !== "true") {
      fireEvent.click(screen.getByRole("button", { name: "묶어 보기" }));
    }
    const groupBtn = () => screen.getAllByRole("button").find((b) => b.getAttribute("aria-expanded") !== null)!;
    await waitFor(() => expect(groupBtn()).toBeTruthy());
    fireEvent.click(groupBtn());
    expect(groupBtn().getAttribute("aria-expanded")).toBe("true");
    // 30초 갱신: 더 새 알림 c 가 같은 묶음에 합류
    rows = [notif("c", "2026-10-09T02:00:00Z"), ...rows];
    await autoRefresh!();
    await waitFor(() => expect(screen.getAllByText(/알림 c/).length).toBeGreaterThan(0));
    expect(groupBtn().getAttribute("aria-expanded")).toBe("true");
  });
});

describe("Inbox — 묶어 보기 기본값은 전역 미읽음 기준", { timeout: 15_000 }, () => {
  const notif = (i: number, type = "mention") => ({ id: `n${i}`, type, title: `알림 ${i}`, link: null, readAt: null, createdAt: `2026-10-09T00:${String(i % 60).padStart(2, "0")}:00Z` });
  const respond = (notifications: ReturnType<typeof notif>[], unread: number) => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ notifications, unread, byType: {} }) }));
    vi.stubGlobal("fetch", fetchMock);
  };
  beforeEach(() => { try { localStorage.clear(); } catch { /* noop */ } });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("전역 미읽음 21건이면 목록이 3건뿐이어도(칩 필터) 묶어서 보인다", async () => {
    respond([notif(1), notif(2), notif(3)], 21);
    render(<Inbox />);
    await waitFor(() => expect(screen.getByRole("button", { name: "묶어 보기" }).getAttribute("aria-pressed")).toBe("true"));
    // 같은 종류 3건 → 묶음 헤더(aria-expanded) 하나
    expect(screen.getAllByRole("button").filter((b) => b.getAttribute("aria-expanded") !== null)).toHaveLength(1);
  });

  it("목록이 25건이어도 전역 미읽음이 20 이하면 평평하게 보인다", async () => {
    respond(Array.from({ length: 25 }, (_, i) => notif(i)), 20);
    render(<Inbox />);
    await waitFor(() => expect(screen.getByText("알림 0")).toBeTruthy());
    expect(screen.getByRole("button", { name: "묶어 보기" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getAllByRole("button").filter((b) => b.getAttribute("aria-expanded") !== null)).toHaveLength(0);
  });

  it("저장된 선택이 기본 판정보다 우선한다", async () => {
    localStorage.setItem("ws.inbox.group", "0");
    respond([notif(1), notif(2)], 50);
    render(<Inbox />);
    await waitFor(() => expect(screen.getByText("알림 1")).toBeTruthy());
    expect(screen.getByRole("button", { name: "묶어 보기" }).getAttribute("aria-pressed")).toBe("false");
  });
});
