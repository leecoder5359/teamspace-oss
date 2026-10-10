// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { findScrollParent } from "@/lib/virtualRows";

function sized(el: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("findScrollParent", () => {
  it("overflow-y:auto 로 실제 넘치는 가장 가까운 조상을 고르고, 안 넘치는 가로 스크롤 래퍼는 건너뛴다", () => {
    document.body.innerHTML = `
      <div id="main" style="overflow-y: auto">
        <div id="wrap" style="overflow-x: auto; overflow-y: auto">
          <table><tbody id="tb"><tr><td>x</td></tr></tbody></table>
        </div>
      </div>`;
    const main = document.getElementById("main")!;
    const wrap = document.getElementById("wrap")!;
    sized(main, 5000, 600);
    sized(wrap, 4000, 4000); // overflow-x:auto 때문에 계산값 overflow-y 도 auto 지만 세로로는 안 넘친다
    expect(findScrollParent(document.getElementById("tb"))).toBe(main);
  });

  it("스크롤 조상이 없거나 null 이면 window", () => {
    document.body.innerHTML = `<div><span id="s"></span></div>`;
    expect(findScrollParent(document.getElementById("s"))).toBe(window);
    expect(findScrollParent(null)).toBe(window);
  });
});

describe("findScrollParent — 1px 여유(I2)", () => {
  it("scrollHeight 가 clientHeight 보다 1px 만 큰 조상은 스크롤 부모가 아니다 → window", () => {
    document.body.innerHTML = `
      <div id="main" style="overflow-y: auto">
        <table><tbody id="tb"><tr><td>x</td></tr></tbody></table>
      </div>`;
    sized(document.getElementById("main")!, 601, 600);
    expect(findScrollParent(document.getElementById("tb"))).toBe(window);
    sized(document.getElementById("main")!, 602, 600);
    expect(findScrollParent(document.getElementById("tb"))).toBe(document.getElementById("main"));
  });
});
