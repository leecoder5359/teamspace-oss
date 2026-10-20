// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

vi.mock("next-auth/react", () => ({ signIn: vi.fn() }));

import LoginPage from "./page";

afterEach(cleanup);

describe("로그인 — 라벨과 입력 연결(U-30)", () => {
  it("워크스페이스 등록 폼의 라벨이 입력에 연결돼 있다(htmlFor/id)", () => {
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: /새 워크스페이스 만들기/ }));
    expect(screen.getByLabelText("워크스페이스 이름").getAttribute("placeholder")).toBe("예: 리코더팩토리");
    expect(screen.getByLabelText(/도메인/).getAttribute("placeholder")).toBe("example.com");
  });
});
