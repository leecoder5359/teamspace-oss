// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, screen, act } from "@testing-library/react";
import { _resetPagesClientForTests, getPagesSync } from "@/lib/pagesClient";

// 사이드바는 이 테스트의 관심이 아니다 — 마운트되기 전에 자식이 캐시를 읽는 경우만 본다.
// 셸이 넘기는 props(inert·onToggleTheme)만 확인한다.
const sidebarProps: { current: Record<string, unknown> } = { current: {} };
vi.mock("./Sidebar", () => ({
  default: (p: Record<string, unknown>) => {
    sidebarProps.current = p;
    return null;
  },
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));

import AppShell, { type InitialSidebar } from "./AppShell";
import { packRows } from "@/lib/rowPack";

const initial: InitialSidebar = {
  pages: [{ id: "a", title: "a", icon: null, parentId: null, position: 0, kind: "doc", projectId: null }] as NonNullable<InitialSidebar>["pages"],
  projects: [],
  serverTime: new Date().toISOString(),
};

beforeEach(() => {
  _resetPagesClientForTests();
  setMobile(false);
});
afterEach(() => cleanup());

describe("AppShell — 서버 목록 시드", () => {
  it("자식의 첫 렌더 전에 공유 캐시가 서버 목록으로 채워진다(사이드바 마운트 전 getPages 도 네트워크 없이)", () => {
    const seen: unknown[] = [];
    function Child() {
      seen.push(getPagesSync()?.data ?? null);
      return null;
    }
    render(<AppShell initialSidebar={initial}><Child /></AppShell>);
    expect(seen[0]).toEqual({ pages: initial!.pages });
  });

  it("스트리밍 프라미스 — 도착해 있으면(status=fulfilled) 자식 첫 렌더 전에, 아니면 도착하는 대로 심는다", async () => {
    const ready = Object.assign(Promise.resolve(initial), { status: "fulfilled", value: initial });
    const seen: unknown[] = [];
    function Child() {
      seen.push(getPagesSync()?.data ?? null);
      return null;
    }
    render(<AppShell initialSidebar={ready}><Child /></AppShell>);
    expect(seen[0]).toEqual({ pages: initial!.pages });

    cleanup();
    _resetPagesClientForTests();
    let resolve!: (v: InitialSidebar) => void;
    const later = new Promise<InitialSidebar>((r) => (resolve = r));
    render(<AppShell initialSidebar={later}><div /></AppShell>);
    expect(getPagesSync()).toBeNull();
    resolve(initial);
    await later;
    await Promise.resolve();
    expect(getPagesSync()?.data).toEqual({ pages: initial!.pages });
  });

  it("열 행렬(packRows)로 온 목록은 원래 배열로 되돌려 심는다", () => {
    render(<AppShell initialSidebar={{ ...initial!, pages: packRows(initial!.pages) }}><div /></AppShell>);
    expect(getPagesSync()?.data).toEqual({ pages: initial!.pages });
  });

  it("initialSidebar 가 없으면 심지 않는다", () => {
    render(<AppShell><div /></AppShell>);
    expect(getPagesSync()).toBeNull();
  });
});

function setMobile(matches: boolean) {
  window.matchMedia = ((q: string) => ({ matches, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
}

describe("AppShell — 모바일 드로어 (U-6)", () => {
  it("모바일에서 닫힌 드로어는 사이드바가 inert, 열면 풀린다. 햄버거는 aria-expanded 로 상태를 알린다", () => {
    setMobile(true);
    render(<AppShell><div /></AppShell>);
    const burger = screen.getByRole("button", { name: "메뉴 열기" });
    expect(burger.getAttribute("aria-expanded")).toBe("false");
    expect(sidebarProps.current.inert).toBe(true);
    fireEvent.click(burger);
    expect(burger.getAttribute("aria-expanded")).toBe("true");
    expect(sidebarProps.current.inert).toBe(false);
  });

  it("데스크톱에서는 사이드바를 inert 로 만들지 않는다", () => {
    setMobile(false);
    render(<AppShell><div /></AppShell>);
    expect(sidebarProps.current.inert).toBe(false);
  });

  it("Escape 로 열린 드로어를 닫는다", () => {
    setMobile(true);
    render(<AppShell><div /></AppShell>);
    const burger = screen.getByRole("button", { name: "메뉴 열기" });
    fireEvent.click(burger);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(burger.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("AppShell — theme-color (U-24)", () => {
  beforeEach(() => {
    document.head.innerHTML = '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#FFFFFF"><meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1E232B">';
    document.documentElement.dataset.theme = "light";
    setMobile(false);
  });

  const contents = () => Array.from(document.querySelectorAll('meta[name="theme-color"]')).map((m) => m.getAttribute("content"));

  it("마운트 시 앱 테마에 맞춰 theme-color 를 맞추고, 토글하면 --surface-card 색으로 바꾼다", () => {
    render(<AppShell><div /></AppShell>);
    expect(contents()).toEqual(["#FFFFFF", "#FFFFFF"]);
    act(() => (sidebarProps.current.onToggleTheme as () => void)());
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(contents()).toEqual(["#1E232B", "#1E232B"]);
  });
});
