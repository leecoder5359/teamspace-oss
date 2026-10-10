// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, waitFor, fireEvent } from "@testing-library/react";

vi.mock("next/link", () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("./sidebar/useSidebarData", () => ({
  useSidebarData: () => ({ refresh: async () => {}, favorites: [], recents: [], groups: [], collapsed: new Set(), toggle: () => {}, loaded: true, ready: true }),
}));
vi.mock("./sidebar/SidebarQuick", () => ({ SidebarQuick: () => null }));
// 트리는 rename 콜백만 노출하는 가짜 — 실제 인라인 편집 UI 는 SidebarTree 쪽 테스트가 본다
vi.mock("./sidebar/SidebarTree", () => ({
  SidebarTree: (p: { rename: (id: string, t: string) => Promise<void> }) => (
    <button onClick={() => void p.rename("d1", "새 제목")}>이름 바꾸기</button>
  ),
}));
const renameCollides = vi.fn();
vi.mock("@/lib/renameDuplicate", () => ({
  DUPLICATE_RENAME_NOTICE: "같은 프로젝트에 같은 제목 문서가 있어요",
  renameCollides: (id: string) => renameCollides(id),
}));

import Sidebar from "./Sidebar";

const patchStatus = { current: 200 };
beforeEach(() => {
  renameCollides.mockReset();
  patchStatus.current = 200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string, init?: RequestInit) =>
      init?.method === "PATCH"
        ? new Response("{}", { status: patchStatus.current })
        : new Response(JSON.stringify({ unread: 0 }), { status: 200 }),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = () =>
  render(<Sidebar rail={false} theme="light" onToggleRail={() => {}} onToggleTheme={() => {}} />);

describe("Sidebar 이름 바꾸기 — 중복 제목 안내", () => {
  it("이름을 바꾼 뒤 helper 가 겹침을 알리면 안내를 보인다", async () => {
    renameCollides.mockResolvedValue(true);
    mount();
    fireEvent.click(screen.getByText("이름 바꾸기"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("같은 프로젝트에 같은 제목 문서가 있어요"));
    expect(renameCollides).toHaveBeenCalledWith("d1");
  });

  it("겹치지 않으면 안내가 없다", async () => {
    renameCollides.mockResolvedValue(false);
    mount();
    fireEvent.click(screen.getByText("이름 바꾸기"));
    await waitFor(() => expect(renameCollides).toHaveBeenCalled());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("PATCH 가 실패하면 겹침 확인도 하지 않는다", async () => {
    patchStatus.current = 403;
    mount();
    fireEvent.click(screen.getByText("이름 바꾸기"));
    await new Promise((r) => setTimeout(r, 30));
    expect(renameCollides).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
