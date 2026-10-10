// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { useRef } from "react";
import { useVirtualRows } from "./useVirtualRows";

/** jsdom 엔 ResizeObserver 가 없다 — observe 시 (실제처럼 비동기로) 첫 보고를 내는 대역. */
class MockRO {
  static all: MockRO[] = [];
  targets = new Set<Element>();
  disconnected = false;
  constructor(public cb: ResizeObserverCallback) {
    MockRO.all.push(this);
  }
  observe(el: Element) {
    this.targets.add(el);
    queueMicrotask(() => this.fire(el));
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.disconnected = true;
    this.targets.clear();
  }
  fire(el: Element) {
    if (this.targets.has(el)) this.cb([{ target: el } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const setScroll = (y: number) => Object.defineProperty(window, "scrollY", { configurable: true, value: y });

function Rows({ total, heightOf }: { total: number; heightOf: (i: number) => number }) {
  const ref = useRef<HTMLTableSectionElement>(null);
  const v = useVirtualRows({ anchorRef: ref, total, enabled: true });
  const idx = Array.from({ length: v.end - v.start }, (_, k) => v.start + k);
  return (
    <table>
      <tbody ref={ref} data-testid="tb" data-rh={v.rowHeight} data-start={v.start}>
        {v.topPad > 0 && (
          <tr aria-hidden="true">
            <td />
          </tr>
        )}
        {idx.map((i) => (
          <tr key={i} data-i={i} data-h={heightOf(i)}>
            <td />
          </tr>
        ))}
      </tbody>
    </table>
  );
}
const tb = () => document.querySelector("[data-testid=tb]")!;
const rh = () => Number(tb().getAttribute("data-rh"));
const start = () => Number(tb().getAttribute("data-start"));

let rectSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  MockRO.all = [];
  vi.stubGlobal("ResizeObserver", MockRO);
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return Number(this.getAttribute("data-h")) || 0;
    },
  });
  setScroll(0);
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 400 });
  rectSpy = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(() => ({ top: 100 - window.scrollY }) as DOMRect);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  rectSpy.mockRestore();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight;
  setScroll(0);
  document.body.innerHTML = "";
});

async function scrollTo(y: number, target: EventTarget = window) {
  setScroll(y);
  await act(async () => {
    target.dispatchEvent(new Event("scroll"));
    await frame();
  });
}

describe("useVirtualRows — 행 높이(I1)", () => {
  it("켜질 때 첫 행을 한 번 재고, 첫 행이 높이가 다른 행으로 바뀌어도 rowHeight 는 그대로다", async () => {
    // 짝수 행 40px, 홀수 행 62px(관계 칩이 줄바꿈된 행)
    render(<Rows total={1000} heightOf={(i) => (i % 2 ? 62 : 40)} />);
    await act(frame);
    expect(rh()).toBe(40);

    const seen = new Set<number>();
    for (const y of [4000, 4040, 4080, 8000, 8040, 12000]) {
      await scrollTo(y);
      seen.add(rh());
      expect(tb().querySelector("tr[data-i]")!.getAttribute("data-i")).toBe(String(start()));
    }
    expect([...seen]).toEqual([40]);
    // 관찰은 다음 측정 프레임에 언마운트된 행에서 지금 첫 행으로 옮겨진다(옮긴 행의 첫 보고는 기준값일 뿐)
    await scrollTo(12000);
    expect(rh()).toBe(40);
    const ro = MockRO.all.at(-1)!;
    expect(ro.targets.size).toBe(1);
    expect([...ro.targets].every((el) => el.isConnected)).toBe(true);
  });

  it("관찰 중인 그 행의 크기가 실제로 바뀌면(밀도 변경) rowHeight 를 갱신한다", async () => {
    render(<Rows total={1000} heightOf={() => 40} />);
    await act(frame);
    expect(rh()).toBe(40);
    const ro = MockRO.all.at(-1)!;
    const el = [...ro.targets][0] as HTMLElement;
    el.setAttribute("data-h", "32");
    await act(async () => {
      ro.fire(el);
      await frame();
    });
    expect(rh()).toBe(32);
  });

  it("언마운트하면 ResizeObserver 를 disconnect 한다", async () => {
    const { unmount } = render(<Rows total={1000} heightOf={() => 40} />);
    await act(frame);
    const ro = MockRO.all.at(-1)!;
    unmount();
    expect(ro.disconnected).toBe(true);
  });
});

describe("useVirtualRows — 스크롤 부모(I2)", () => {
  it("document 캡처 단계로 받으므로 아무 요소의(버블링 안 하는) scroll 도 창을 움직인다", async () => {
    render(<Rows total={1000} heightOf={() => 40} />);
    await act(frame);
    const other = document.body.appendChild(document.createElement("div"));
    await scrollTo(4100, other);
    expect(start()).toBe(90);
  });

  it("고른 부모가 이벤트 시점에 실제로 스크롤하지 않으면 window 기준으로 읽는다", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    host.style.overflowY = "auto";
    Object.defineProperty(host, "scrollHeight", { configurable: true, value: 50000 });
    Object.defineProperty(host, "clientHeight", { configurable: true, value: 600 });
    render(<Rows total={1000} heightOf={() => 40} />, { container: host });
    await act(frame);
    // 레이아웃이 바뀌어 host 가 더는 넘치지 않는다 — 실제 스크롤은 window
    Object.defineProperty(host, "scrollHeight", { configurable: true, value: 600 });
    await scrollTo(4100);
    expect(start()).toBe(90);
  });
});
