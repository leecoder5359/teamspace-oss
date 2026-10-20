// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

// 주소창 쿼리 — 뒤로/앞으로·같은 경로 이동은 이 값이 바뀌는 것으로 흉내 낸다.
let search = "";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams(search) }));
vi.mock("@/lib/useAutoRefresh", () => ({ useAutoRefresh: () => {} }));
const pagesMock = vi.hoisted(() => ({ pages: [] as unknown[], gate: Promise.resolve() as Promise<unknown> }));
vi.mock("@/lib/pagesClient", () => ({
  getPages: async () => {
    await pagesMock.gate;
    return { ok: true, status: 200, data: { pages: pagesMock.pages } };
  },
}));

import Docs from "./Docs";

const decision = { id: "d1", title: "인증은 Auth.js", context: null, decision: null, status: "accepted", decidedAt: "2026-10-01T00:00:00Z", project: null };

describe("Docs 허브 — 탭·선택을 URL 로(U-11)", { timeout: 15_000 }, () => {
  let replaceState: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      new Response(JSON.stringify(String(url).startsWith("/api/decisions") ? { decisions: [decision] } : { projects: [] }), { status: 200 }),
    ));
    replaceState = vi.spyOn(window.history, "replaceState");
  });
  afterEach(() => {
    cleanup();
    pagesMock.pages = [];
    pagesMock.gate = Promise.resolve();
    replaceState.mockRestore();
    vi.unstubAllGlobals();
  });

  it("URL 쿼리가 바뀌면(뒤로 가기·사이드바 /docs) 탭·선택을 URL 에 맞춘다", async () => {
    search = "cat=decisions&id=d1";
    const { rerender } = render(<Docs initialParams={{ cat: "decisions", id: "d1" }} />);
    expect(await screen.findByRole("heading", { name: "인증은 Auth.js" })).toBeTruthy();
    search = "cat=decisions";
    rerender(<Docs initialParams={{ cat: "decisions", id: "d1" }} />);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "인증은 Auth.js" })).toBeNull());
    search = "cat=decisions&id=d1";
    rerender(<Docs initialParams={{ cat: "decisions", id: "d1" }} />);
    expect(await screen.findByRole("heading", { name: "인증은 Auth.js" })).toBeTruthy();
    search = "";
    rerender(<Docs initialParams={{ cat: "decisions", id: "d1" }} />);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "인증은 Auth.js" })).toBeNull());
    await waitFor(() => expect(replaceState).toHaveBeenLastCalledWith(null, "", "/docs"));
  });

  it("자기 replaceState 로 바뀐 쿼리(상태와 같음)는 상태를 다시 건드리지 않는다", async () => {
    search = "cat=decisions&id=d1";
    const { rerender } = render(<Docs initialParams={{ cat: "decisions", id: "d1" }} />);
    expect(await screen.findByRole("heading", { name: "인증은 Auth.js" })).toBeTruthy();
    fireEvent.click(screen.getByTitle("닫기"));
    await waitFor(() => expect(replaceState).toHaveBeenLastCalledWith(null, "", "/docs?cat=decisions"));
    const writes = replaceState.mock.calls.length;
    // Next 가 replaceState 를 useSearchParams 에 반영한 상황 — 상태와 같으므로 아무 일도 없어야 한다
    search = "cat=decisions";
    rerender(<Docs initialParams={{ cat: "decisions", id: "d1" }} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("heading", { name: "인증은 Auth.js" })).toBeNull();
    expect(replaceState.mock.calls.length).toBe(writes);
  });

  it("?cat=decisions&id= 로 열면 결정 탭에서 그 결정 상세가 열리고, 닫으면 URL 에서 id 가 빠진다", async () => {
    search = "cat=decisions&id=d1";
    render(<Docs initialParams={{ cat: "decisions", id: "d1" }} />);
    expect(await screen.findByRole("heading", { name: "인증은 Auth.js" })).toBeTruthy();
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/docs?cat=decisions&id=d1");
    fireEvent.click(screen.getByTitle("닫기"));
    await waitFor(() => expect(replaceState).toHaveBeenLastCalledWith(null, "", "/docs?cat=decisions"));
  });

  it("문서 탭: 받아 온 목록에 없는 ?id= 는 URL 에서 뺀다(있는 id 는 그대로 연다)", async () => {
    pagesMock.pages = [{ id: "doc1", title: "있는 문서", kind: "doc", icon: null, projectId: null, parentId: null, updatedAt: "2026-10-01T00:00:00Z" }];
    search = "id=ghost";
    render(<Docs initialParams={{ id: "ghost" }} />);
    await waitFor(() => expect(replaceState).toHaveBeenLastCalledWith(null, "", "/docs"));
    cleanup();
    replaceState.mockClear();
    search = "id=doc1";
    render(<Docs initialParams={{ id: "doc1" }} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(replaceState.mock.calls.some((c: unknown[]) => c[2] === "/docs")).toBe(false);
  });

  it("결정 탭: 받아 온 목록에 없는 ?id= 는 URL 에서 뺀다", async () => {
    search = "cat=decisions&id=ghost";
    render(<Docs initialParams={{ cat: "decisions", id: "ghost" }} />);
    await waitFor(() => expect(replaceState).toHaveBeenLastCalledWith(null, "", "/docs?cat=decisions"));
  });

  it("문서 탭: 목록을 받는 중(loading)에는 ?id= 를 빼지 않고, 받은 뒤 있는 문서면 그대로 연다", async () => {
    pagesMock.pages = [{ id: "doc1", title: "있는 문서", kind: "doc", icon: null, projectId: null, parentId: null, updatedAt: "2026-10-01T00:00:00Z" }];
    let release!: () => void;
    pagesMock.gate = new Promise<void>((r) => { release = r; });
    search = "id=doc1";
    render(<Docs initialParams={{ id: "doc1" }} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(replaceState.mock.calls.some((c: unknown[]) => c[2] === "/docs")).toBe(false);
    expect(replaceState).toHaveBeenLastCalledWith(null, "", "/docs?cat=mddocs&id=doc1");
    release();
    await waitFor(() => expect(screen.getAllByText("있는 문서").length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 30));
    expect(replaceState.mock.calls.some((c: unknown[]) => c[2] === "/docs")).toBe(false);
  });
});
