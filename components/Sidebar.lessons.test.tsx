// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ children, href, title }: { children: React.ReactNode; href: string; title?: string }) => (
    <a href={href} title={title}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("./sidebar/useSidebarData", () => ({
  useSidebarData: () => ({ refresh: async () => {}, favorites: [], recents: [], groups: [], collapsed: new Set(), toggle: () => {}, loaded: true, ready: true }),
}));
vi.mock("./sidebar/SidebarQuick", () => ({ SidebarQuick: () => null }));
vi.mock("./sidebar/SidebarTree", () => ({ SidebarTree: () => null }));

import Sidebar from "./Sidebar";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ unread: 0 }), { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Sidebar 레슨 메뉴", () => {
  it("일반 섹션에 레슨(/lessons) 링크가 있다", () => {
    render(<Sidebar rail={false} theme="light" onToggleRail={() => {}} onToggleTheme={() => {}} />);
    expect(screen.getByTitle("레슨").getAttribute("href")).toBe("/lessons");
  });
});
