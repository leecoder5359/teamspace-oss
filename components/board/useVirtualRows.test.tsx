// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { useRef } from "react";
import { useVirtualRows } from "./useVirtualRows";

afterEach(cleanup);

function Probe({ total, enabled }: { total: number; enabled: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const { start, end, topPad, bottomPad } = useVirtualRows({ anchorRef: ref, total, enabled });
  return <div ref={ref} data-testid="probe" data-r={JSON.stringify({ start, end, topPad, bottomPad })} />;
}
const read = () => JSON.parse(document.querySelector("[data-testid=probe]")!.getAttribute("data-r")!);

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

describe("useVirtualRows", () => {
  it("enabled=false 면 전체 범위·패딩 0", () => {
    render(<Probe total={500} enabled={false} />);
    expect(read()).toMatchObject({ start: 0, end: 500, topPad: 0, bottomPad: 0 });
  });

  it("enabled 면 창만, window 스크롤에 따라 rAF 뒤 범위가 움직인다", async () => {
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => ({ top: 100 - window.scrollY }) as DOMRect);
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 400 });
    render(<Probe total={1000} enabled />);
    await act(frame);
    expect(read().start).toBe(0);
    // 앵커가 y=100 에서 시작 → 처음 화면엔 300px = 8행 + overscan 10
    expect(read().end).toBe(18);
    expect(read().bottomPad).toBe(982 * 40);

    Object.defineProperty(window, "scrollY", { configurable: true, value: 4000 });
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
      await frame();
    });
    // 앵커(tbody)는 문서 y=100 에서 시작 → 상대 스크롤 3900px = 97.5행 → overscan 10
    expect(read().start).toBe(87);
    expect(read().end).toBe(118);
    expect(read().topPad).toBe(87 * 40);
    spy.mockRestore();
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
  });

  it("total 이 바뀌면 같은 측정값으로 바로 재계산된다(정렬·필터)", async () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 400 });
    const { rerender } = render(<Probe total={1000} enabled />);
    await act(frame);
    rerender(<Probe total={12} enabled />);
    expect(read()).toMatchObject({ start: 0, end: 12, topPad: 0, bottomPad: 0 });
  });
});
