// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, waitFor, fireEvent } from "@testing-library/react";

let search = "id=old1";
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(search) }));

import Approvals from "./Approvals";

const mk = (id: string, title: string) => ({
  id, title, body: "", kind: "general", highRisk: false, status: "pending",
  responseText: null, createdAt: "2026-10-01T00:00:00Z", respondedAt: null,
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const T = { timeout: 3_000 }; // 부하 시 두 번의 순차 fetch + 포커스 effect 가 기본 1초를 넘길 수 있다
const fetchMock = vi.fn();
const calls = (pre: string) => fetchMock.mock.calls.filter(([u]) => String(u).startsWith(pre));

beforeEach(() => {
  fetchMock.mockReset();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Approvals ?id= 포커스", { timeout: 15_000 }, () => {
  it("목록에 없으면 단건을 한 번 조회해 카드를 붙이고 포커스한다", async () => {
    search = "id=old1";
    fetchMock.mockImplementation(async (u: string) => {
      if (u === "/api/approvals") return json({ approvals: [mk("n1", "최신 건")] });
      if (u === "/api/approvals/old1") return json({ approval: mk("old1", "오래된 건") });
      return json({}, 404);
    });
    render(<Approvals />);
    await waitFor(() => {
      expect(document.getElementById("approval-old1")?.getAttribute("data-flash")).toBe("1");
      expect(screen.getByText("오래된 건")).toBeTruthy();
    }, T);
    expect(calls("/api/approvals/old1")).toHaveLength(1);
    expect(screen.queryByText("해당 승인을 찾을 수 없어요")).toBeNull();
  });

  it("단건 조회도 404 면 안내 문구를 보이고 더 재조회하지 않는다", async () => {
    search = "id=gone";
    fetchMock.mockImplementation(async (u: string) => {
      if (u === "/api/approvals") return json({ approvals: [mk("n1", "최신 건")] });
      return json({ error: "Not found" }, 404);
    });
    render(<Approvals />);
    await waitFor(() => expect(screen.getByText("해당 승인을 찾을 수 없어요")).toBeTruthy(), T);
    expect(calls("/api/approvals/gone")).toHaveLength(1);
  });

  it("목록에 이미 있으면 단건 조회를 하지 않는다", async () => {
    search = "id=n1";
    fetchMock.mockImplementation(async () => json({ approvals: [mk("n1", "최신 건")] }));
    render(<Approvals />);
    await waitFor(() => expect(document.getElementById("approval-n1")?.getAttribute("data-flash")).toBe("1"), T);
    expect(calls("/api/approvals/")).toHaveLength(0);
  });

  it("load() 가 목록을 교체해도 붙인 카드를 다시 조회해 유지한다(사라지면 안내)", async () => {
    search = "id=old1";
    let single = 0;
    fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
      if (u === "/api/approvals" && !init?.method) return json({ approvals: [mk("n1", "최신 건")] });
      if (init?.method === "PATCH") return json({ approval: {} });
      if (u === "/api/approvals/old1") {
        single++;
        return single === 1 ? json({ approval: mk("old1", "오래된 건") }) : single === 2 ? json({ approval: mk("old1", "오래된 건 갱신") }) : json({ error: "gone" }, 404);
      }
      return json({}, 404);
    });
    render(<Approvals />);
    await waitFor(() => expect(screen.getByText("오래된 건")).toBeTruthy(), T);
    const toggle = screen.getByLabelText(/낮은 위험 자동 승인/);
    fireEvent.click(toggle); // PATCH 후 load() → 목록 교체
    await waitFor(() => expect(screen.getByText("오래된 건 갱신")).toBeTruthy(), T);
    expect(calls("/api/approvals/old1").filter(([, i]) => !i?.method)).toHaveLength(2);
    fireEvent.click(toggle); // 끄기: load 없음
    fireEvent.click(toggle); // 다시 켜기 → load → 이번엔 404
    await waitFor(() => expect(screen.getByText("해당 승인을 찾을 수 없어요")).toBeTruthy(), T);
  });
});

describe("Approvals — 화면 제목(U-29)", () => {
  it("<h1> 은 '승인 대기 인박스' 하나", async () => {
    search = "";
    fetchMock.mockImplementation(async () => json({ approvals: [mk("n1", "최신 건")] }));
    const { container } = render(<Approvals />);
    await waitFor(() => expect(screen.getByText("최신 건")).toBeTruthy(), T);
    const h1s = container.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe("승인 대기 인박스");
  });
});

describe("Approvals 로딩·오류·변경 실패(U-2·U-3)", () => {
  it("목록을 받기 전에는 불러오는 중을 보인다", async () => {
    search = "";
    fetchMock.mockImplementation(() => new Promise(() => {}));
    render(<Approvals />);
    expect(screen.getByText("불러오는 중…")).toBeTruthy();
  });

  it("목록 조회가 실패하면 안내와 다시 시도를 보이고, 다시 시도로 회복한다", async () => {
    search = "";
    let fail = true;
    fetchMock.mockImplementation(async () => (fail ? json({ error: "x" }, 500) : json({ approvals: [mk("n1", "최신 건")] })));
    render(<Approvals />);
    expect(await screen.findByText("승인 목록을 불러오지 못했어요.")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByText("다시 시도"));
    expect(await screen.findByText("최신 건")).toBeTruthy();
  });

  it("목록 fetch 가 거부돼도 안내를 보인다", async () => {
    search = "";
    fetchMock.mockImplementation(async () => {
      throw new TypeError("network");
    });
    render(<Approvals />);
    expect(await screen.findByText("승인 목록을 불러오지 못했어요.")).toBeTruthy();
  });

  it("요청 생성이 실패하면 '생성됨' 대신 오류를 보이고 입력을 유지한다", async () => {
    search = "";
    fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
      if (u === "/api/approvals" && init?.method === "POST") return json({ error: "승인 생성에 실패했습니다." }, 500);
      return json({ approvals: [] });
    });
    render(<Approvals />);
    const input = (await screen.findByPlaceholderText("승인 요청 제목")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "배포" } });
    fireEvent.click(screen.getByText("슬랙으로 승인 요청 보내기"));
    expect((await screen.findByRole("alert")).textContent).toBe("승인 생성에 실패했습니다.");
    expect(screen.queryByText(/생성됨/)).toBeNull();
    expect((screen.getByPlaceholderText("승인 요청 제목") as HTMLInputElement).value).toBe("배포");
  });

  it("결정(승인)이 실패하면 오류를 보인다", async () => {
    search = "";
    fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
      if (u === "/api/approvals/n1" && init?.method === "PATCH") return json({ error: "이미 처리됨" }, 409);
      return json({ approvals: [mk("n1", "최신 건")] });
    });
    render(<Approvals />);
    await screen.findByText("최신 건");
    fireEvent.click(screen.getByText("승인"));
    expect((await screen.findByRole("alert")).textContent).toBe("이미 처리됨");
  });

  it("목록을 받은 뒤 다시 읽기가 실패하면 목록은 그대로 두고 안내와 다시 시도를 보인다", async () => {
    search = "";
    let failList = false;
    fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
      if (u === "/api/approvals/n1" && init?.method === "PATCH") {
        failList = true;
        return json({ approval: {} });
      }
      return failList ? json({ error: "x" }, 500) : json({ approvals: [mk("n1", "최신 건")] });
    });
    render(<Approvals />);
    await screen.findByText("최신 건");
    fireEvent.click(screen.getByText("승인"));
    expect(await screen.findByText("승인 목록을 불러오지 못했어요.")).toBeTruthy();
    expect(screen.getByText("최신 건")).toBeTruthy();
    failList = false;
    fireEvent.click(screen.getByText("다시 시도"));
    await waitFor(() => expect(screen.queryByText("승인 목록을 불러오지 못했어요.")).toBeNull());
    expect(screen.getByText("최신 건")).toBeTruthy();
  });
});

describe("Approvals 낮은 위험 자동 승인", () => {
  it("일부 요청이 실패하면 서버 오류를 보이고 성공한 건수만 알린다", async () => {
    search = "";
    fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
      if (u === "/api/approvals/n2" && init?.method === "PATCH") return json({ error: "이미 처리됨" }, 409);
      if (init?.method === "PATCH") return json({ approval: {} });
      return json({ approvals: [mk("n1", "첫 건"), mk("n2", "둘째 건")] });
    });
    render(<Approvals />);
    await screen.findByText("첫 건");
    fireEvent.click(screen.getByRole("checkbox", { name: /낮은 위험 자동 승인/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("이미 처리됨");
    expect(screen.getByText("낮은 위험 1건을 자동 승인했어요.")).toBeTruthy();
  });

  it("요청이 거부(네트워크)돼도 던지지 않고 기본 오류를 보인다", async () => {
    search = "";
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) => {
      if (init?.method === "PATCH") throw new TypeError("network");
      return json({ approvals: [mk("n1", "첫 건")] });
    });
    render(<Approvals />);
    await screen.findByText("첫 건");
    fireEvent.click(screen.getByRole("checkbox", { name: /낮은 위험 자동 승인/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("처리하지 못했습니다.");
    expect(screen.queryByText(/자동 승인했어요/)).toBeNull();
  });
});

describe("Approvals 생성 안내 문구", () => {
  it("슬랙 미발송인데 이유가 없으면 'undefined' 없이 '생성됨(슬랙 미발송)'", async () => {
    search = "";
    fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
      if (u === "/api/approvals" && init?.method === "POST") return json({ approval: mk("n9", "배포"), sent: false });
      return json({ approvals: [] });
    });
    render(<Approvals />);
    fireEvent.change(await screen.findByPlaceholderText("승인 요청 제목"), { target: { value: "배포" } });
    fireEvent.click(screen.getByText("슬랙으로 승인 요청 보내기"));
    expect(await screen.findByText("생성됨(슬랙 미발송)")).toBeTruthy();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  it("이유가 있으면 함께 보인다", async () => {
    search = "";
    fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
      if (u === "/api/approvals" && init?.method === "POST") return json({ approval: mk("n9", "배포"), sent: false, error: "토큰 없음" });
      return json({ approvals: [] });
    });
    render(<Approvals />);
    fireEvent.change(await screen.findByPlaceholderText("승인 요청 제목"), { target: { value: "배포" } });
    fireEvent.click(screen.getByText("슬랙으로 승인 요청 보내기"));
    expect(await screen.findByText("생성됨(슬랙 미발송: 토큰 없음)")).toBeTruthy();
  });
});
