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
