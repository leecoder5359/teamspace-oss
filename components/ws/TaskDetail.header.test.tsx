// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import TaskDetail from "./TaskDetail";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const props = {
  row: { id: "r1", props: { t: "카드" }, position: 0 },
  properties: [{ id: "t", name: "제목", type: "text" as const, config: null, position: 0 }],
  roles: new Map(),
  titleId: "t",
  onChange: () => {},
  onClose: () => {},
};

describe("태스크 상세 헤더(U-12)", () => {
  it("동작 없는 '슬랙으로 리마인드' 버튼을 보이지 않는다", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [], comments: [] }), { status: 200 })));
    render(<TaskDetail {...props} />);
    expect(screen.getByRole("button", { name: "닫기" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /슬랙으로 리마인드/ })).toBeNull();
  });
});

describe("태스크 상세 입력 포커스 표시(U-8)", () => {
  it("체크리스트·댓글 입력은 DS 포커스 링 클래스를 받는다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [], comments: [] }), { status: 200 })));
    render(<TaskDetail {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /^체크리스트/ }));
    expect(screen.getByLabelText("체크리스트 항목").classList.contains("ws-focus-ring")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^댓글/ }));
    expect(screen.getByLabelText("댓글").classList.contains("ws-focus-ring")).toBe(true);
  });
});
