// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("next-auth/react", () => ({ signIn: vi.fn() }));

import LoginPage from "./page";

afterEach(cleanup);

describe("로그인 — 준비 중 진입점 숨김(U-12)", () => {
  it("동작 없는 '새 워크스페이스 만들기' 진입점과 등록 폼을 보이지 않는다", () => {
    render(<LoginPage />);
    expect(screen.getByRole("button", { name: /Google로 계속하기/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /새 워크스페이스 만들기/ })).toBeNull();
    expect(screen.queryByLabelText("워크스페이스 이름")).toBeNull();
  });
});
