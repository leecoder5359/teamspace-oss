// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, waitFor, fireEvent } from "@testing-library/react";
import LessonsSurface from "./LessonsSurface";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const T = { timeout: 3_000 };
const fetchMock = vi.fn();
let role = "editor";

const mine = (id: string, extra: object = {}) => ({
  id, title: `규칙 ${id}`, body: "본문", projectId: null, personal: true, mode: "default",
  createdById: "u1", updatedAt: "2026-10-18T00:00:00Z", sharedWithTeam: true, copiedFromId: null, copiedFrom: null, ...extra,
});

let lessons: object[] = [];
beforeEach(() => {
  role = "editor";
  lessons = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (u: string) => {
    if (u.startsWith("/api/lessons?")) return json({ lessons, total: lessons.length });
    if (u.startsWith("/api/proposals")) return json({ proposals: [] });
    if (u === "/api/workspace") return json({ role });
    return json({ lesson: {} });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const calledWith = (url: string, method: string) =>
  fetchMock.mock.calls.find(([u, init]) => u === url && (init as RequestInit | undefined)?.method === method);

describe("LessonsSurface scope", { timeout: 15_000 }, () => {
  it("team — scope=team 으로 조회하고 제안 대기도 읽는다, '나에게만' 체크는 없다", async () => {
    render(<LessonsSurface project="" scope="team" />);
    await waitFor(() => screen.getByText("팀 작업규칙"), T);
    expect(fetchMock.mock.calls.some(([u]) => u === "/api/lessons?scope=team")).toBe(true);
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/proposals"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^\s*규칙 추가$/ }));
    expect(screen.queryByText("나에게만(개인)")).toBeNull();
  });

  it("mine — 제목·조회, 제안은 읽지 않고 등록은 항상 personal", async () => {
    render(<LessonsSurface project="p1" scope="mine" />);
    await waitFor(() => screen.getByText("내 레슨"), T);
    expect(fetchMock.mock.calls.some(([u]) => u === "/api/lessons?scope=mine&projectId=p1")).toBe(true);
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/proposals"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /^\s*규칙 추가$/ }));
    expect(screen.queryByText("이 프로젝트에만 적용")).toBeNull();
    expect(screen.queryByText("나에게만(개인)")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText(/규칙 제목/), { target: { value: "제목" } });
    fireEvent.change(screen.getByPlaceholderText(/본문/), { target: { value: "내용" } });
    fireEvent.click(screen.getByRole("button", { name: "등록" }));
    await waitFor(() => expect(calledWith("/api/lessons", "POST")).toBeTruthy(), T);
    const body = JSON.parse(String((calledWith("/api/lessons", "POST")![1] as RequestInit).body));
    expect(body.personal).toBe(true);
    expect(body.projectId).toBeUndefined();
  });

  it("mine — 가져온 레슨 출처 배지(이름·원본 삭제됨)와 숨김 배지", async () => {
    lessons = [
      mine("A", { copiedFromId: "S1", copiedFrom: { id: "S1", authorName: "비", deleted: false } }),
      mine("B", { copiedFromId: "S2", copiedFrom: { id: "S2", authorName: null, deleted: true } }),
      mine("C", { sharedWithTeam: false }),
    ];
    render(<LessonsSurface project="" scope="mine" />);
    await waitFor(() => screen.getByText("비 님에게서 가져옴"), T);
    expect(screen.getByText("원본 삭제됨")).toBeTruthy();
    expect(screen.getByText("팀원에게 숨김")).toBeTruthy();
  });

  it("mine — 팀원에게 숨기기/공개 토글은 PATCH sharedWithTeam", async () => {
    lessons = [mine("A"), mine("B", { sharedWithTeam: false })];
    render(<LessonsSurface project="" scope="mine" />);
    await waitFor(() => screen.getByRole("button", { name: "팀원에게 숨기기" }), T);
    fireEvent.click(screen.getByRole("button", { name: "팀원에게 숨기기" }));
    await waitFor(() => expect(calledWith("/api/lessons/A", "PATCH")).toBeTruthy(), T);
    expect(JSON.parse(String((calledWith("/api/lessons/A", "PATCH")![1] as RequestInit).body))).toEqual({ sharedWithTeam: false });
    fireEvent.click(screen.getByRole("button", { name: "팀원에게 공개" }));
    await waitFor(() => expect(calledWith("/api/lessons/B", "PATCH")).toBeTruthy(), T);
    expect(JSON.parse(String((calledWith("/api/lessons/B", "PATCH")![1] as RequestInit).body))).toEqual({ sharedWithTeam: true });
  });

  it("mine — '팀 레슨으로 올리기' 는 admin 만, 누르면 promote", async () => {
    lessons = [mine("A")];
    render(<LessonsSurface project="" scope="mine" />);
    await waitFor(() => screen.getByRole("button", { name: "팀원에게 숨기기" }), T);
    expect(screen.queryByRole("button", { name: "팀 레슨으로 올리기" })).toBeNull();
    cleanup();

    role = "admin";
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<LessonsSurface project="p1" scope="mine" />);
    await waitFor(() => screen.getByRole("button", { name: "팀 레슨으로 올리기" }), T);
    fireEvent.click(screen.getByRole("button", { name: "팀 레슨으로 올리기" }));
    await waitFor(() => expect(calledWith("/api/lessons/A/promote", "POST")).toBeTruthy(), T);
    expect(JSON.parse(String((calledWith("/api/lessons/A/promote", "POST")![1] as RequestInit).body))).toEqual({ projectId: "p1" });
  });

  it("team — 토글·올리기 버튼은 없다", async () => {
    role = "admin";
    lessons = [mine("A", { personal: false })];
    render(<LessonsSurface project="" scope="team" />);
    await waitFor(() => screen.getByText("규칙 A"), T);
    expect(screen.queryByRole("button", { name: "팀원에게 숨기기" })).toBeNull();
    expect(screen.queryByRole("button", { name: "팀 레슨으로 올리기" })).toBeNull();
  });
});
