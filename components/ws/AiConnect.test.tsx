// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { render, cleanup, screen, waitFor, fireEvent } from "@testing-library/react";

import AiConnect, { LoadErrorNotice } from "./AiConnect";

describe("AiConnect — 로드 전 스켈레톤", () => {
  it("제목은 즉시 보이고 요약 카드 3개·세션 행 5개가 스켈레톤이다", () => {
    const html = renderToStaticMarkup(<AiConnect />);
    expect(html).toContain("AI 연결");
    expect(html).toContain("Claude 작업 세션");
    expect((html.match(/ws-skeleton/g) ?? []).length).toBe(8);
    expect(html).not.toContain("불러오는 중");
  });

  it("불러오기 실패 안내는 한 줄 메시지와 다시 시도 버튼을 보인다", () => {
    const html = renderToStaticMarkup(<LoadErrorNotice onRetry={() => {}} />);
    expect(html).toContain("불러오지 못했어요");
    expect(html).toContain("다시 시도");
    expect(html).toContain("ws-btn-soft");
  });
});

describe("AiConnect — 컨텍스트 실패", { timeout: 15_000 }, () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("/api/context 실패 시 컨텍스트 스켈레톤 대신 안내+다시 시도, 재시도 성공하면 본문", async () => {
    let ctxOk = false;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).startsWith("/api/sessions")) return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
      if (String(url).startsWith("/api/context")) {
        return ctxOk
          ? new Response(JSON.stringify({ markdown: "# 컨텍스트 본문", counts: { tasks: 1, docs: 2, decisions: 0, risks: 0, glossary: 0 } }), { status: 200 })
          : new Response("boom", { status: 500 });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<AiConnect />);
    await waitFor(() => expect(screen.getByText("컨텍스트를 불러오지 못했어요.")).toBeTruthy());
    // 세션 목록은 정상 — 세션 실패 안내는 없다
    expect(screen.queryByText("세션 목록을 불러오지 못했어요.")).toBeNull();
    expect(container.querySelectorAll(".ws-skeleton").length).toBe(0);
    ctxOk = true;
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(screen.getByText("# 컨텍스트 본문")).toBeTruthy());
    expect(screen.queryByText("컨텍스트를 불러오지 못했어요.")).toBeNull();
  });
});
