// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import QaSurface from "./QaSurface";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const qa = { id: "q1", title: "로그인 확인", steps: null, expected: null, status: "pending", project: null };

beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => json({ scenarios: [qa] }))));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("QaSurface 상세 다이얼로그(U-5)", () => {
  it("제목으로 이름이 붙고, 닫기에 포커스, Escape 로 닫히며 연 행으로 포커스가 돌아간다", async () => {
    render(<QaSurface project="" />);
    const item = (await screen.findByText("로그인 확인")).closest<HTMLElement>("[role=button]")!;
    item.focus();
    fireEvent.click(item);
    const dialog = screen.getByRole("dialog");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("로그인 확인");
    expect(document.activeElement).toBe(screen.getByTitle("닫기"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(item);
  });
});
