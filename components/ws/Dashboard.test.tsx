// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/useAutoRefresh", () => ({ useAutoRefresh: () => {} }));
vi.mock("@/lib/pagesClient", () => ({ getPages: async () => ({ ok: true, data: { pages: [] } }) }));

import Dashboard from "./Dashboard";

afterEach(() => {
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
