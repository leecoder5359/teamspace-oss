// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, waitFor, fireEvent } from "@testing-library/react";
import GlossarySurface from "./GlossarySurface";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function serve(post: Response) {
  fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
    if (u === "/api/glossary" && init?.method === "POST") return post;
    if (String(u).startsWith("/api/pages")) return json({ pages: [] });
    return json({ terms: [] });
  });
}
async function submit() {
  render(<GlossarySurface />);
  fireEvent.click(await screen.findByText("용어 추가"));
  fireEvent.change(screen.getByPlaceholderText(/용어 \(예/), { target: { value: "워크스페이스" } });
  fireEvent.change(screen.getByPlaceholderText("정의"), { target: { value: "팀 공간" } });
  fireEvent.click(screen.getByText("저장"));
}

describe("GlossarySurface 변경 실패(U-2)", () => {
  it("만들기가 실패하면 오류를 보이고 입력·폼을 유지한다", async () => {
    serve(json({ error: "이미 있는 용어입니다." }, 409));
    await submit();
    expect((await screen.findByRole("alert")).textContent).toBe("이미 있는 용어입니다.");
    expect((screen.getByPlaceholderText("정의") as HTMLTextAreaElement).value).toBe("팀 공간");
  });

  it("만들기가 성공하면 폼을 닫는다", async () => {
    serve(json({ term: { id: "g1" } }, 201));
    await submit();
    await waitFor(() => expect(screen.queryByPlaceholderText("정의")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
