// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { ERROR_COPY } from "@/components/ErrorScreen";
import WsError from "./error";

afterEach(cleanup);

// (ws) 그룹 안의 경계라 레이아웃(AppShell·사이드바)은 남고 본문만 오류 화면으로 바뀐다(U-15).
describe("(ws)/error — 워크스페이스 화면 오류 경계", () => {
  it("공통 오류 문구와 다시 시도·홈으로를 보이고, 다시 시도는 unstable_retry 를 부른다", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const retry = vi.fn();
    render(<WsError error={Object.assign(new Error("boom"), { digest: "d1" })} unstable_retry={retry} />);
    expect(screen.getByRole("heading", { name: ERROR_COPY.errorTitle })).toBeTruthy();
    expect(screen.getByText(ERROR_COPY.errorBody)).toBeTruthy();
    expect(screen.getByRole("link", { name: "홈으로" }).getAttribute("href")).toBe("/");
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});
