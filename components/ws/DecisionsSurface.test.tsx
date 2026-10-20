// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { useState } from "react";
import DecisionsSurface from "./DecisionsSurface";

// 선택은 허브(Docs)가 들고 있다(U-11) — 테스트에서는 같은 역할의 상태만 둔다.
function Surface({ project, initial = null }: { project: string; initial?: string | null }) {
  const [selId, setSelId] = useState<string | null>(initial);
  return <DecisionsSurface project={project} selId={selId} onSelect={setSelId} />;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const dec = { id: "d1", title: "인증은 Auth.js", context: null, decision: null, status: "accepted", decidedAt: "2026-10-01T00:00:00Z", project: null };
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DecisionsSurface 변경 실패(U-2)", () => {
  it("만들기가 실패하면 오류를 보이고 입력·폼을 유지한다", async () => {
    fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
      if (u === "/api/decisions" && init?.method === "POST") return json({ error: "권한이 없습니다." }, 403);
      return json({ decisions: [] });
    });
    render(<Surface project="" />);
    fireEvent.click(await screen.findByText("첫 결정 기록"));
    const input = screen.getByPlaceholderText(/결정 제목/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "새 결정" } });
    fireEvent.click(screen.getByText("저장"));
    expect((await screen.findByRole("alert")).textContent).toBe("권한이 없습니다.");
    expect((screen.getByPlaceholderText(/결정 제목/) as HTMLInputElement).value).toBe("새 결정");
  });

  it("만들기가 성공하면 폼을 닫는다", async () => {
    fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
      if (u === "/api/decisions" && init?.method === "POST") return json({ decision: dec }, 201);
      return json({ decisions: [] });
    });
    render(<Surface project="" />);
    fireEvent.click(await screen.findByText("첫 결정 기록"));
    fireEvent.change(screen.getByPlaceholderText(/결정 제목/), { target: { value: "새 결정" } });
    fireEvent.click(screen.getByText("저장"));
    await waitFor(() => expect(screen.queryByPlaceholderText(/결정 제목/)).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("상세에서 삭제가 실패하면 드로어를 닫지 않고 오류를 보인다", async () => {
    fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
      if (u === "/api/decisions/d1" && init?.method === "DELETE") return json({}, 500);
      return json({ decisions: [dec] });
    });
    render(<Surface project="" />);
    fireEvent.click(await screen.findByText("인증은 Auth.js"));
    fireEvent.click(screen.getByTitle("삭제"));
    expect((await screen.findByRole("alert")).textContent).toBe("삭제하지 못했습니다.");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("DecisionsSurface 표(U-27)", () => {
  it("표 래퍼는 가로 스크롤된다", async () => {
    fetchMock.mockImplementation(async () => json({ decisions: [dec] }));
    render(<Surface project="" />);
    await screen.findByText("인증은 Auth.js");
    fireEvent.click(screen.getByTitle("표"));
    const wrap = document.querySelector("table")!.parentElement!;
    expect(wrap.style.overflowX).toBe("auto");
  });
});

describe("DecisionsSurface 표 행 키보드(U-4)", () => {
  it.each(["Enter", " "])("표 행에서 %j 키로 상세를 연다", async (key) => {
    fetchMock.mockImplementation(async () => json({ decisions: [dec] }));
    render(<Surface project="" />);
    await screen.findByText("인증은 Auth.js");
    fireEvent.click(screen.getByTitle("표"));
    const tr = screen.getByText("인증은 Auth.js").closest("tr")!;
    expect(tr.getAttribute("role")).toBe("button");
    expect(tr.tabIndex).toBe(0);
    fireEvent.keyDown(tr, { key });
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
});

describe("DecisionsSurface 타임라인·카드 키보드(U-4 후속)", () => {
  it.each([
    ["타임라인", "Enter"],
    ["타임라인", " "],
    ["카드", "Enter"],
    ["카드", " "],
  ])("%s 항목에서 %j 키로 상세를 열고 기본 동작(스크롤)을 막는다", async (viewTitle, key) => {
    fetchMock.mockImplementation(async () => json({ decisions: [dec] }));
    render(<Surface project="" />);
    await screen.findByText("인증은 Auth.js");
    fireEvent.click(screen.getByTitle(viewTitle));
    const item = screen.getByText("인증은 Auth.js").closest<HTMLElement>("[role=button]")!;
    expect(fireEvent.keyDown(item, { key })).toBe(false);
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
});

describe("DecisionsSurface 상세 다이얼로그(U-5)", () => {
  it("제목으로 이름이 붙고, 닫기에 포커스, Escape 로 닫히며 연 행으로 포커스가 돌아간다", async () => {
    fetchMock.mockImplementation(async () => json({ decisions: [dec] }));
    render(<Surface project="" />);
    const item = (await screen.findByText("인증은 Auth.js")).closest<HTMLElement>("[role=button]")!;
    item.focus();
    fireEvent.click(item);
    const dialog = screen.getByRole("dialog");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("인증은 Auth.js");
    expect(document.activeElement).toBe(screen.getByTitle("닫기"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(item);
  });
});

describe("DecisionsSurface 오래된 오류(리뷰 지적)", () => {
  const failingCreate = async (u: string, init?: RequestInit) =>
    u === "/api/decisions" && init?.method === "POST" ? json({ error: "권한이 없습니다." }, 403) : json({ decisions: [dec] });

  it("만들기 실패 → 취소 → 항목 열기 하면 드로어에 지난 오류가 없다", async () => {
    fetchMock.mockImplementation(failingCreate);
    render(<Surface project="" />);
    await screen.findByText("인증은 Auth.js");
    fireEvent.click(screen.getByText("결정 추가"));
    fireEvent.change(screen.getByPlaceholderText(/결정 제목/), { target: { value: "새 결정" } });
    fireEvent.click(screen.getByText("저장"));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByText("취소"));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByText("인증은 Auth.js"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("만들기 실패 후 폼을 둔 채 항목을 열어도 드로어에 지난 오류가 없다", async () => {
    fetchMock.mockImplementation(failingCreate);
    render(<Surface project="" />);
    await screen.findByText("인증은 Auth.js");
    fireEvent.click(screen.getByText("결정 추가"));
    fireEvent.change(screen.getByPlaceholderText(/결정 제목/), { target: { value: "새 결정" } });
    fireEvent.click(screen.getByText("저장"));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByText("인증은 Auth.js"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("[role=alert]")).toBeNull();
  });
});

describe("DecisionsSurface 목록 밖 딥링크(?id=)", () => {
  const far = { ...dec, id: "d9", title: "오래된 결정" };

  it("목록에 없는 선택은 단건으로 읽어 상세를 연다", async () => {
    fetchMock.mockImplementation(async (u: string) => (u === "/api/decisions/d9" ? json({ decision: far }) : json({ decisions: [dec] })));
    render(<Surface project="" initial="d9" />);
    const dialog = await screen.findByRole("dialog");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe("오래된 결정");
  });

  it("단건도 없으면(404) 선택을 푼다", async () => {
    fetchMock.mockImplementation(async (u: string) => (u === "/api/decisions/gone" ? json({ error: "Not found" }, 404) : json({ decisions: [dec] })));
    const onSelect = vi.fn();
    render(<DecisionsSurface project="" selId="gone" onSelect={onSelect} />);
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(null));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("목록 밖 결정의 상태를 바꾸면 다시 읽어 드로어에 반영한다", async () => {
    let cur = far;
    fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
      if (u === "/api/decisions/d9" && init?.method === "PATCH") {
        cur = { ...far, status: JSON.parse(String(init.body)).status };
        return json({ ok: true });
      }
      if (u === "/api/decisions/d9") return json({ decision: cur });
      return json({ decisions: [dec] });
    });
    render(<Surface project="" initial="d9" />);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "대체됨" }));
    await waitFor(() => expect(within(screen.getByRole("dialog")).queryByRole("button", { name: "대체됨" })).toBeNull());
    expect(cur.status).toBe("superseded");
  });

  it("상태 변경 뒤 다시 읽을 때 사라졌으면(404) 선택을 푼다", async () => {
    let gone = false;
    fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
      if (u === "/api/decisions/d9" && init?.method === "PATCH") {
        gone = true; // 다른 사람이 그사이 지웠다
        return json({ ok: true });
      }
      if (u === "/api/decisions/d9") return gone ? json({ error: "Not found" }, 404) : json({ decision: far });
      return json({ decisions: [dec] });
    });
    const onSelect = vi.fn();
    render(<DecisionsSurface project="" selId="d9" onSelect={onSelect} />);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "대체됨" }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(null));
  });
});
