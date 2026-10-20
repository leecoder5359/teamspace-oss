// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, waitFor, fireEvent } from "@testing-library/react";
import LessonsTeammates from "./LessonsTeammates";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const T = { timeout: 3_000 };
const fetchMock = vi.fn();
const tl = (id: string, name: string, copiedId: string | null = null) => ({
  id, title: `규칙 ${id}`, body: "본문", projectId: null, mode: "default", personal: true,
  author: { id: `u-${name}`, name }, copiedId, updatedAt: "2026-10-18T00:00:00Z",
});

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("LessonsTeammates", { timeout: 15_000 }, () => {
  it("사람별로 묶고, 이미 가져온 건 '가져옴', 가져오기 누르면 copy 후 '가져옴'", async () => {
    fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
      if (u === "/api/lessons?scope=teammates") return json({ lessons: [tl("A", "비"), tl("B", "비", "C9"), tl("C", "씨")], total: 3 });
      if (u === "/api/lessons/A/copy" && init?.method === "POST") return json({ lesson: { id: "NEW" } });
      return json({}, 404);
    });
    render(<LessonsTeammates />);
    await waitFor(() => expect(screen.getByText("비")).toBeTruthy(), T);
    expect(screen.getByText("씨")).toBeTruthy();
    expect(screen.getAllByText("가져옴")).toHaveLength(1);
    fireEvent.click(screen.getAllByRole("button", { name: "가져오기" })[0]);
    await waitFor(() => expect(screen.getAllByText("가져옴")).toHaveLength(2), T);
    expect(fetchMock).toHaveBeenCalledWith("/api/lessons/A/copy", expect.objectContaining({ method: "POST" }));
  });

  it("409 도 '가져옴' 으로 표시한다", async () => {
    fetchMock.mockImplementation(async (u: string) => {
      if (u === "/api/lessons?scope=teammates") return json({ lessons: [tl("A", "비")], total: 1 });
      if (u === "/api/lessons/A/copy") return json({ error: "이미", lessonId: "X" }, 409);
      return json({}, 404);
    });
    render(<LessonsTeammates />);
    await waitFor(() => screen.getByRole("button", { name: "가져오기" }), T);
    fireEvent.click(screen.getByRole("button", { name: "가져오기" }));
    await waitFor(() => expect(screen.getByText("가져옴")).toBeTruthy(), T);
  });

  it("그 밖의 실패는 오류 문구를 보이고 버튼을 남긴다", async () => {
    fetchMock.mockImplementation(async (u: string) => {
      if (u === "/api/lessons?scope=teammates") return json({ lessons: [tl("A", "비")], total: 1 });
      if (u === "/api/lessons/A/copy") return json({ error: "Not found" }, 404);
      return json({}, 404);
    });
    render(<LessonsTeammates />);
    await waitFor(() => screen.getByRole("button", { name: "가져오기" }), T);
    fireEvent.click(screen.getByRole("button", { name: "가져오기" }));
    await waitFor(() => expect(screen.getByText("Not found")).toBeTruthy(), T);
    expect(screen.getByRole("button", { name: "가져오기" })).toBeTruthy();
  });

  it("비어 있으면 안내 문구", async () => {
    fetchMock.mockResolvedValue(json({ lessons: [], total: 0 }));
    render(<LessonsTeammates />);
    await waitFor(() => expect(screen.getByText("팀원이 공개한 레슨이 없어요")).toBeTruthy(), T);
  });
});
