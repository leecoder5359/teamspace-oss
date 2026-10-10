// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { render, cleanup, waitFor, act } from "@testing-library/react";

/* mermaid 실물은 jsdom 에서 레이아웃(getBBox)이 없어 못 그린다 — 경계만 확인한다. */
const initialize = vi.fn();
const renderFn = vi.fn();
vi.mock("mermaid", () => ({ default: { initialize, render: renderFn } }));

import MarkdownPreview from "./MarkdownPreview";

beforeAll(() => {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  renderFn.mockReset();
  delete document.documentElement.dataset.theme;
});

const md = (code: string) => ["```mermaid", code, "```"].join("\n");

describe("MermaidBlock", () => {
  it("그리기 전엔 원문, 성공하면 svg 로 바꾼다 — initialize 는 strict 로 한 번만", async () => {
    renderFn.mockResolvedValue({ svg: '<svg data-testid="d"><g/></svg>' });
    const first = render(<MarkdownPreview markdown={md("graph TD; A-->B")} />);
    expect(first.container.querySelector("pre code")?.textContent).toBe("graph TD; A-->B");
    await waitFor(() => expect(first.container.querySelector(".ws-mermaid svg")).not.toBeNull());
    expect(first.container.querySelector("pre")).toBeNull();

    const second = render(<MarkdownPreview markdown={md("graph LR; X-->Y")} />);
    await waitFor(() => expect(second.container.querySelector(".ws-mermaid svg")).not.toBeNull());

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(initialize.mock.calls[0][0]).toMatchObject({ startOnLoad: false, securityLevel: "strict", theme: "default" });
    // 블록마다 다른 render id — CSS 선택자로 쓸 수 있는 글자만
    const ids = renderFn.mock.calls.map((c) => c[0] as string);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^mmd-[a-zA-Z0-9_-]+$/);
  });

  it("실패하면 원문을 남기고 안내를 붙인다", async () => {
    renderFn.mockRejectedValue(new Error("Parse error"));
    const { container, findByText } = render(<MarkdownPreview markdown={md("not a diagram")} />);
    await findByText("다이어그램을 그리지 못했어요 — 원문 표시");
    expect(container.querySelector("pre code")?.textContent).toBe("not a diagram");
  });

  it("앱 테마(data-theme)가 바뀌면 새 테마로 initialize 하고 다시 그린다", async () => {
    renderFn.mockResolvedValue({ svg: "<svg><g/></svg>" });
    initialize.mockClear();
    document.documentElement.dataset.theme = "dark";
    const { container } = render(<MarkdownPreview markdown={md("graph TD; T-->H")} />);
    await waitFor(() => expect(container.querySelector(".ws-mermaid svg")).not.toBeNull());
    expect(initialize.mock.calls.at(-1)?.[0]).toMatchObject({ theme: "dark" });

    const before = renderFn.mock.calls.length;
    await act(async () => {
      document.documentElement.dataset.theme = "light";
    });
    await waitFor(() => expect(renderFn.mock.calls.length).toBeGreaterThan(before));
    expect(initialize.mock.calls.at(-1)?.[0]).toMatchObject({ theme: "default" });
  });
});
