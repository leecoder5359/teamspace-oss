// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { useRef } from "react";
import DocToc from "./DocToc";

let narrow = false;
beforeAll(() => {
  window.matchMedia = ((q: string) => ({ matches: narrow, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  narrow = false;
});

function Harness({ children, min }: { children: React.ReactNode; min?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div>
      <div ref={ref}>{children}</div>
      <DocToc rootRef={ref} minHeadings={min} />
    </div>
  );
}

describe("DocToc", () => {
  it("h1~h3 를 모아 목차를 그리고, id 없는 헤딩엔 id 를 준다", async () => {
    const { container, getByRole } = render(
      <Harness>
        <h1 id="개요">개요<a className="ws-heading-anchor">#</a></h1>
        <h2>설치</h2>
        <h3>설치</h3>
        <h4>무시</h4>
      </Harness>,
    );
    const nav = await waitFor(() => getByRole("navigation", { name: "목차" }));
    const links = Array.from(nav.querySelectorAll("a"));
    expect(links.map((a) => a.textContent)).toEqual(["개요", "설치", "설치"]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["#개요", "#설치", "#설치-2"]);
    expect(Array.from(nav.querySelectorAll("li")).map((li) => li.className)).toEqual(["ws-toc-l1", "ws-toc-l2", "ws-toc-l3"]);
    expect(container.querySelector("h2")?.id).toBe("설치");
    expect(container.querySelector("h3")?.id).toBe("설치-2");

    fireEvent.click(links[2]);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(window.location.hash).toBe("#" + encodeURIComponent("설치-2"));
    expect(links[2].getAttribute("aria-current")).toBe("true");
  });

  it("헤딩이 minHeadings 미만이면 그리지 않는다", async () => {
    const { queryByRole } = render(
      <Harness>
        <h2>하나</h2>
        <h2>둘</h2>
      </Harness>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(queryByRole("navigation")).toBeNull();
  });

  it("편집기(contenteditable) 안 헤딩엔 id 를 쓰지 않는다", async () => {
    const { container, getByRole } = render(
      <Harness min={1}>
        <div contentEditable="true" suppressContentEditableWarning>
          <h2>편집 중</h2>
        </div>
      </Harness>,
    );
    await waitFor(() => getByRole("navigation", { name: "목차" }));
    expect(container.querySelector("h2")?.id).toBe("");
  });

  it("편집기 헤딩은 id 가 없어도 location.hash 로 해당 헤딩까지 스크롤한다", async () => {
    const scrolled: string[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.textContent ?? "");
    };
    window.history.replaceState(null, "", "#" + encodeURIComponent("설치"));
    try {
      const { container, getByRole } = render(
        <Harness min={1}>
          <div contentEditable="true" suppressContentEditableWarning>
            <h2>개요</h2>
            <h2>설치</h2>
          </div>
        </Harness>,
      );
      await waitFor(() => getByRole("navigation", { name: "목차" }));
      await waitFor(() => expect(scrolled).toEqual(["설치"]));
      const hs = container.querySelectorAll("h2");
      expect([hs[0].id, hs[1].id]).toEqual(["", ""]);
    } finally {
      Element.prototype.scrollIntoView = orig;
      window.history.replaceState(null, "", "#");
    }
  });

  it("편집기 헤딩: PM 데코레이션이 id 를 단 래퍼(.bn-block-content)를 해시 대상으로 쓴다", async () => {
    const scrolled: Element[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    // uniqueIds 는 원래 목록의 "설치-2" 를 그 주인에게 남기므로 두 번째 "설치" 는 설치-3 이 된다.
    // DOM 만 보고 다시 세면(buildTocFromDom) 설치-2 가 되어 어긋난다 — 목차는 래퍼 id 를 그대로 써야 한다.
    window.history.replaceState(null, "", "#" + encodeURIComponent("설치-3"));
    try {
      const { container, getByRole } = render(
        <Harness min={1}>
          <div contentEditable="true" suppressContentEditableWarning>
            <div className="bn-block-content" id="설치">
              <h2>설치</h2>
            </div>
            <div className="bn-block-content" id="설치-3">
              <h2>설치</h2>
            </div>
            <div className="bn-block-content" id="설치-2">
              <h2>설치-2</h2>
            </div>
          </div>
        </Harness>,
      );
      const nav = await waitFor(() => getByRole("navigation", { name: "목차" }));
      const links = Array.from(nav.querySelectorAll("a"));
      expect(links.map((a) => a.getAttribute("href"))).toEqual(["#설치", "#설치-3", "#설치-2"]);
      const wrapper = container.querySelector('[id="설치-3"]');
      await waitFor(() => expect(scrolled).toEqual([wrapper]));
      expect(links[1].getAttribute("aria-current")).toBe("true");
      // 헤딩 요소 자체엔 여전히 아무것도 쓰지 않는다
      expect(Array.from(container.querySelectorAll("h2")).map((h) => h.id)).toEqual(["", "", ""]);
    } finally {
      Element.prototype.scrollIntoView = orig;
      window.history.replaceState(null, "", "#");
    }
  });

  it("편집기: 슬러그 id 를 가진 바깥 컨테이너는 스크롤 대상이 아니다(헤딩 래퍼만)", async () => {
    const scrolled: Element[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    window.history.replaceState(null, "", "#main");
    try {
      const { container, getByRole } = render(
        <Harness min={1}>
          <div contentEditable="true" suppressContentEditableWarning id="main">
            <div className="bn-block-content">
              <h2>main</h2>
            </div>
          </div>
        </Harness>,
      );
      await waitFor(() => getByRole("navigation", { name: "목차" }));
      await new Promise((r) => setTimeout(r, 50));
      expect(scrolled).not.toContain(container.querySelector('[id="main"]'));
    } finally {
      Element.prototype.scrollIntoView = orig;
      window.history.replaceState(null, "", "#");
    }
  });

  it("프리뷰 경로: 헤딩에 이미 id 가 있으면 hash 폴백은 스크롤하지 않는다(브라우저가 처리)", async () => {
    const scrolled: string[] = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.textContent ?? "");
    };
    window.history.replaceState(null, "", "#" + encodeURIComponent("설치"));
    try {
      const { getByRole } = render(
        <Harness min={1}>
          <h2 id="개요">개요</h2>
          <h2 id="설치">설치</h2>
        </Harness>,
      );
      await waitFor(() => getByRole("navigation", { name: "목차" }));
      await new Promise((r) => setTimeout(r, 50));
      expect(scrolled).toEqual([]);
    } finally {
      Element.prototype.scrollIntoView = orig;
      window.history.replaceState(null, "", "#");
    }
  });

  it("임베드(data-toc-skip) 안 헤딩은 목차에 넣지 않고 id 도 쓰지 않는다", async () => {
    const { container, getByRole } = render(
      <Harness min={1}>
        <h2 id="개요">개요</h2>
        <div data-toc-skip="">
          <h2>개요</h2>
          <div>
            <h3>임베드 안 깊은 헤딩</h3>
          </div>
        </div>
        <h2>마무리</h2>
      </Harness>,
    );
    const nav = await waitFor(() => getByRole("navigation", { name: "목차" }));
    expect(Array.from(nav.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual(["#개요", "#마무리"]);
    const skipped = container.querySelectorAll("[data-toc-skip] h2, [data-toc-skip] h3");
    expect(Array.from(skipped).map((h) => h.id)).toEqual(["", ""]);
  });

  it("좁은 화면(<1024px)에선 숨긴다", async () => {
    narrow = true;
    const { queryByRole } = render(
      <Harness min={1}>
        <h2>하나</h2>
      </Harness>,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(queryByRole("navigation")).toBeNull();
  });
});
