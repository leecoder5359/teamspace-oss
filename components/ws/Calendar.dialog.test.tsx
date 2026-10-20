// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { EventDetail, type CalEvent } from "./Calendar";

afterEach(cleanup);

const ev: CalEvent = { id: "e1", scope: "document", date: "2026-10-20", title: "회의록", docId: "p1" };

describe("Calendar 이벤트 상세(U-5)", () => {
  it("제목으로 이름이 붙고, 닫기에 포커스, Escape 로 onClose 를 부른다", () => {
    const onClose = vi.fn();
    render(<EventDetail ev={ev} databaseId={null} onClose={onClose} onOpenTask={vi.fn()} onOpenDoc={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("회의록");
    expect(document.activeElement).toBe(screen.getByTitle("닫기"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
