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

describe("CommandPalette — Escape 는 팔레트만 닫는다(드로어 등 뒤의 Escape 리스너로 새지 않게)", () => {
  it("열린 상태의 Escape 는 팔레트를 닫고 window 의 다른 Escape 리스너에 닿지 않는다", async () => {
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    try {
      render(<CommandPalette />);
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      const input = await screen.findByRole("textbox", { name: "검색어" });
      behind.mockClear();
      fireEvent.keyDown(input, { key: "Escape" });
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(behind).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", behind);
    }
  });

  it("한글 입력 조합 중(isComposing)의 Escape 는 조합 취소용이라 팔레트를 닫지 않고 막지도 않는다", async () => {
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    try {
      render(<CommandPalette />);
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      const input = await screen.findByRole("textbox", { name: "검색어" });
      behind.mockClear();
      fireEvent.keyDown(input, { key: "Escape", isComposing: true });
      expect(screen.getByRole("listbox")).toBeTruthy();
      expect(behind).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", behind);
    }
  });

  it("닫힌 상태의 Escape 는 막지 않는다(드로어가 그대로 닫힐 수 있게)", () => {
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    try {
      render(<CommandPalette />);
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(behind).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", behind);
    }
  });
});
