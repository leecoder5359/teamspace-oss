import { describe, it, expect, vi } from "vitest";
import { createEventHub, type EventSourceLike } from "./eventHub";

class FakeES implements EventSourceLike {
  listeners = new Map<string, (() => void)[]>();
  closed = false;
  addEventListener(type: string, fn: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() { this.closed = true; }
  fire(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }
}

function setup(opts: { hidden?: boolean; openThrows?: boolean } = {}) {
  const sources: FakeES[] = [];
  let hidden = opts.hidden ?? false;
  let visCb: (() => void) | null = null;
  const unwatch = vi.fn(() => { visCb = null; });
  const hub = createEventHub({
    open: () => {
      if (opts.openThrows) throw new Error("unsupported");
      const es = new FakeES();
      sources.push(es);
      return es;
    },
    isHidden: () => hidden,
    watchVisibility: (cb) => { visCb = cb; return unwatch; },
  });
  const setHidden = (h: boolean) => { hidden = h; visCb?.(); };
  const listener = () => ({ onHello: vi.fn(), onEvent: vi.fn(), onError: vi.fn() });
  return { hub, sources, setHidden, listener, unwatch, watching: () => visCb !== null };
}

describe("createEventHub — 공유 EventSource", () => {
  it("구독자가 여럿이어도 연결은 하나, 마지막 구독 해제 때 닫는다", () => {
    const { hub, sources, listener } = setup();
    const offA = hub.subscribe(listener());
    const offB = hub.subscribe(listener());
    expect(sources).toHaveLength(1);
    offA();
    expect(sources[0].closed).toBe(false);
    offB();
    expect(sources[0].closed).toBe(true);
  });

  it("activity·notification 은 모든 구독자에게, hello·error 도 모두에게", () => {
    const { hub, sources, listener } = setup();
    const a = listener();
    const b = listener();
    hub.subscribe(a);
    hub.subscribe(b);
    sources[0].fire("hello");
    sources[0].fire("activity");
    sources[0].fire("notification");
    sources[0].fire("error");
    for (const l of [a, b]) {
      expect(l.onHello).toHaveBeenCalledTimes(1);
      expect(l.onEvent).toHaveBeenCalledTimes(2);
      expect(l.onError).toHaveBeenCalledTimes(1);
    }
  });

  it("이미 연결된 뒤 들어온 구독자도 hello 를 받는다 — 에러 뒤에는 받지 않는다", () => {
    const { hub, sources, listener } = setup();
    hub.subscribe(listener());
    sources[0].fire("hello");
    const late = listener();
    hub.subscribe(late);
    expect(late.onHello).toHaveBeenCalledTimes(1);
    sources[0].fire("error");
    const later = listener();
    hub.subscribe(later);
    expect(later.onHello).not.toHaveBeenCalled();
  });

  it("해제한 구독자는 더 이상 이벤트를 받지 않는다", () => {
    const { hub, sources, listener } = setup();
    const a = listener();
    const off = hub.subscribe(a);
    hub.subscribe(listener());
    off();
    sources[0].fire("activity");
    expect(a.onEvent).not.toHaveBeenCalled();
  });

  it("탭이 숨으면 닫고, 다시 보이면 새로 연다", () => {
    const { hub, sources, setHidden, listener } = setup();
    const a = listener();
    hub.subscribe(a);
    setHidden(true);
    expect(sources[0].closed).toBe(true);
    sources[0].fire("activity"); // 닫힌 연결의 늦은 이벤트는 무시
    expect(a.onEvent).not.toHaveBeenCalled();
    setHidden(false);
    expect(sources).toHaveLength(2);
    expect(sources[1].closed).toBe(false);
  });

  it("숨은 탭에서 구독하면 열지 않고, 보일 때 연다", () => {
    const { hub, sources, setHidden, listener } = setup({ hidden: true });
    hub.subscribe(listener());
    expect(sources).toHaveLength(0);
    setHidden(false);
    expect(sources).toHaveLength(1);
  });

  it("가시성 감시는 첫 구독에 걸고 마지막 해제에 푼다", () => {
    const { hub, listener, unwatch, watching } = setup();
    expect(watching()).toBe(false);
    const offA = hub.subscribe(listener());
    const offB = hub.subscribe(listener());
    expect(watching()).toBe(true);
    offA();
    expect(unwatch).not.toHaveBeenCalled();
    offB();
    expect(unwatch).toHaveBeenCalledTimes(1);
  });

  it("EventSource 를 만들 수 없어도 구독은 동작한다(폴링 폴백은 호출부 몫)", () => {
    const { hub, listener } = setup({ openThrows: true });
    const a = listener();
    expect(() => hub.subscribe(a)()).not.toThrow();
    expect(a.onHello).not.toHaveBeenCalled();
  });
});
