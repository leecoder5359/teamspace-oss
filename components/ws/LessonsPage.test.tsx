// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, waitFor, fireEvent } from "@testing-library/react";

let search = "";
const replace = vi.fn();
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(search), useRouter: () => ({ replace, push: vi.fn() }) }));

import LessonsPage, { lessonsHref } from "./LessonsPage";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const fetchMock = vi.fn();
const T = { timeout: 3_000 };

beforeEach(() => {
  fetchMock.mockReset();
  replace.mockReset();
  fetchMock.mockImplementation(async (u: string) => {
    if (u.startsWith("/api/lessons")) return json({ lessons: [], total: 0 });
    if (u.startsWith("/api/proposals")) return json({ proposals: [] });
    if (u === "/api/workspace") return json({ role: "editor" });
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const called = (pred: (u: string) => boolean) => fetchMock.mock.calls.some(([u]) => pred(String(u)));

describe("LessonsPage", { timeout: 15_000 }, () => {
  it("lessonsHref — 프로젝트가 있으면 ?project=", () => {
    expect(lessonsHref("")).toBe("/lessons");
    expect(lessonsHref("__none__")).toBe("/lessons");
    expect(lessonsHref("p1")).toBe("/lessons?project=p1");
  });

  it("기본 탭 = 팀 레슨(scope=team)", async () => {
    search = "";
    render(<LessonsPage />);
    await waitFor(() => expect(called((u) => u.startsWith("/api/lessons?scope=team"))).toBe(true), T);
  });

  it("?tab=mine 이면 scope=mine, ?project= 를 함께 넘긴다", async () => {
    search = "project=p1&tab=mine";
    render(<LessonsPage />);
    await waitFor(() => expect(called((u) => u === "/api/lessons?scope=mine&projectId=p1")).toBe(true), T);
  });

  it("?tab=teammates 면 팀원 목록", async () => {
    search = "tab=teammates";
    render(<LessonsPage />);
    await waitFor(() => expect(called((u) => u === "/api/lessons?scope=teammates")).toBe(true), T);
  });

  it("탭을 누르면 URL 의 tab 을 바꾼다(북마크 가능)", () => {
    search = "project=p1";
    render(<LessonsPage />);
    fireEvent.click(screen.getByRole("button", { name: "내 레슨" }));
    expect(replace).toHaveBeenCalledWith("/lessons?project=p1&tab=mine");
    fireEvent.click(screen.getByRole("button", { name: "팀 레슨" }));
    expect(replace).toHaveBeenLastCalledWith("/lessons?project=p1");
  });
});

describe("LessonsPage — 화면 제목(U-29)", { timeout: 15_000 }, () => {
  it("<h1> 은 '레슨' 하나(탭 위, 화면에는 보이지 않는 제목)", async () => {
    search = "";
    const { container } = render(<LessonsPage />);
    await waitFor(() => expect(called((u) => u.startsWith("/api/lessons"))).toBe(true), T);
    const h1s = container.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe("레슨");
    expect(h1s[0].className).toContain("sr-only");
  });
});
