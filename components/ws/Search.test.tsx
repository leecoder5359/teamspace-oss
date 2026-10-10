// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, fireEvent, cleanup, screen, waitFor } from "@testing-library/react";

const routerReplace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: routerReplace }) }));

import Search from "./Search";

const fetchMock = vi.fn();

describe("Search — ?q URL 동기화", { timeout: 15_000 }, () => {
  let replaceState: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    routerReplace.mockReset();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ docs: [], decisions: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    replaceState = vi.spyOn(window.history, "replaceState");
  });
  afterEach(() => {
    cleanup();
    replaceState.mockRestore();
    vi.unstubAllGlobals();
  });

  it("입력은 디바운스 뒤 history.replaceState 로 ?q 를 쓴다(router.replace 서버 왕복 없음)", async () => {
    render(<Search />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "배포 규칙" } });
    await waitFor(() => expect(replaceState).toHaveBeenCalledWith(null, "", `/search?q=${encodeURIComponent("배포 규칙")}`));
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it("딥링크 initialQ 와 같으면 갱신하지 않고, 비우면 ?q 를 뗀다", async () => {
    render(<Search initialQ="배포" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(replaceState).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    await waitFor(() => expect(replaceState).toHaveBeenCalledWith(null, "", "/search"));
    expect(routerReplace).not.toHaveBeenCalled();
  });
});
