// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, waitFor, fireEvent } from "@testing-library/react";
import RisksSurface from "./RisksSurface";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const risk = { id: "k1", title: "배포 지연", description: null, severity: "high", status: "open", project: null };
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RisksSurface 변경 실패(U-2)", () => {
  it("만들기가 실패하면 오류를 보이고 입력·폼을 유지한다", async () => {
    fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
      if (u === "/api/risks" && init?.method === "POST") return json({ error: "제목을 입력해 주세요." }, 400);
      return json({ risks: [] });
    });
    render(<RisksSurface project="" />);
    fireEvent.click(await screen.findByText("첫 리스크 추가"));
    fireEvent.change(screen.getByPlaceholderText("리스크 제목"), { target: { value: "새 리스크" } });
    fireEvent.click(screen.getByText("저장"));
    expect((await screen.findByRole("alert")).textContent).toBe("제목을 입력해 주세요.");
    expect((screen.getByPlaceholderText("리스크 제목") as HTMLInputElement).value).toBe("새 리스크");
  });

  it("만들기가 성공하면 폼을 닫는다", async () => {
    fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
      if (u === "/api/risks" && init?.method === "POST") return json({ risk }, 201);
      return json({ risks: [] });
    });
    render(<RisksSurface project="" />);
    fireEvent.click(await screen.findByText("첫 리스크 추가"));
    fireEvent.change(screen.getByPlaceholderText("리스크 제목"), { target: { value: "새 리스크" } });
    fireEvent.click(screen.getByText("저장"));
    await waitFor(() => expect(screen.queryByPlaceholderText("리스크 제목")).toBeNull());
  });

  it("상태 변경이 실패하면 드로어 안에 오류를 보인다", async () => {
    fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
      if (u === "/api/risks/k1" && init?.method === "PATCH") return json({}, 500);
      return json({ risks: [risk] });
    });
    render(<RisksSurface project="" />);
    fireEvent.click(await screen.findByText("배포 지연"));
    fireEvent.click(screen.getByText("완화"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("저장하지 못했습니다.");
    expect(screen.getByRole("dialog").contains(alert)).toBe(true);
  });
});

describe("RisksSurface 상세 다이얼로그(U-5)", () => {
  it("제목으로 이름이 붙고, 닫기에 포커스, Escape 로 닫히며 연 행으로 포커스가 돌아간다", async () => {
    fetchMock.mockImplementation(async () => json({ risks: [risk] }));
    render(<RisksSurface project="" />);
    const item = (await screen.findByText("배포 지연")).closest<HTMLElement>("[role=button]")!;
    item.focus();
    fireEvent.click(item);
    const dialog = screen.getByRole("dialog");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("배포 지연");
    expect(document.activeElement).toBe(screen.getByTitle("닫기"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(item);
  });
});

describe("RisksSurface 오래된 오류(리뷰 지적)", () => {
  const failingCreate = async (u: string, init?: RequestInit) =>
    u === "/api/risks" && init?.method === "POST" ? json({ error: "제목을 입력해 주세요." }, 400) : json({ risks: [risk] });

  it("만들기 실패 → 취소 → 항목 열기 하면 드로어에 지난 오류가 없다", async () => {
    fetchMock.mockImplementation(failingCreate);
    render(<RisksSurface project="" />);
    await screen.findByText("배포 지연");
    fireEvent.click(screen.getByText("리스크 추가"));
    fireEvent.change(screen.getByPlaceholderText("리스크 제목"), { target: { value: "새 리스크" } });
    fireEvent.click(screen.getByText("저장"));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByText("취소"));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByText("배포 지연"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("만들기 실패 후 폼을 둔 채 항목을 열어도 드로어에 지난 오류가 없다", async () => {
    fetchMock.mockImplementation(failingCreate);
    render(<RisksSurface project="" />);
    await screen.findByText("배포 지연");
    fireEvent.click(screen.getByText("리스크 추가"));
    fireEvent.change(screen.getByPlaceholderText("리스크 제목"), { target: { value: "새 리스크" } });
    fireEvent.click(screen.getByText("저장"));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByText("배포 지연"));
    expect(screen.getByRole("dialog").querySelector("[role=alert]")).toBeNull();
  });
});
