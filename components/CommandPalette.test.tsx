// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/pagesClient", () => ({ getPages: async () => ({ ok: true, data: { pages: [] } }) }));

import CommandPalette from "./CommandPalette";

// jsdom 에는 scrollIntoView 가 없다(커서 따라 스크롤 effect).
Element.prototype.scrollIntoView = function () {};

afterEach(cleanup);

describe("CommandPalette — 결과 목록 ARIA(U-19)", () => {
  it("결과는 listbox 안의 option 이고, 커서가 있는 항목만 aria-selected", async () => {
    render(<CommandPalette />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const list = await screen.findByRole("listbox");
    const options = screen.getAllByRole("option");
    expect(list.contains(options[0])).toBe(true);
    expect(options.length).toBeGreaterThan(1);
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual(["true", ...options.slice(1).map(() => "false")]);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "검색어" }), { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
  });
});
