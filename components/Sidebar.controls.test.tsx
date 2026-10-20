// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

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

const mount = (sessionUser: Parameters<typeof Sidebar>[0]["sessionUser"] = null) =>
  render(<Sidebar rail={false} theme="light" onToggleRail={() => {}} onToggleTheme={() => {}} sessionUser={sessionUser} />);

describe("Sidebar — 가짜 컨트롤 없음(U-12)·폴백 사용자(U-13)", () => {
  it("워크스페이스 표시는 버튼이 아니다(눌러도 아무 일 없는 컨트롤을 두지 않는다)", () => {
    const { container } = mount();
    const company = container.querySelector(".ws-company")!;
    expect(company.tagName).not.toBe("BUTTON");
    expect(screen.queryByRole("button", { name: /리코더팩토리/ })).toBeNull();
  });

  it("사용자 카드는 설정(/settings)으로 가는 링크다", () => {
    const { container } = mount({ name: "테스터", email: "t@example.com", image: null });
    const card = container.querySelector(".ws-user-card")!;
    expect(card.tagName).toBe("A");
    expect(card.getAttribute("href")).toBe("/settings");
    expect(card.textContent).toContain("테스터");
  });

  it("세션이 없으면 '사용자'와 빈 이메일 — 실명·개인 이메일을 하드코딩하지 않는다", () => {
    const { container } = mount(null);
    expect(container.querySelector(".ws-user-name")!.textContent).toBe("사용자");
    expect(container.querySelector(".ws-user-sub")!.textContent).toBe("");
  });
});
