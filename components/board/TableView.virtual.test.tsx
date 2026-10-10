// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { TableView, classifyRoles, type DbProperty, type DbRow } from "../DatabaseView";

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
});

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const props: DbProperty[] = [{ id: "t", name: "제목", type: "text", config: null, position: 0 }];
const rows: DbRow[] = Array.from({ length: 300 }, (_, i) => ({ id: `r${i}`, props: { t: `행 ${i}` }, position: i }));
const noop = () => {};
const row = (i: number) => document.querySelector(`tr[data-row-id="r${i}"]`);

describe("TableView 가상 스크롤 — 포커스 행 유지(I3)", () => {
  it("행 5 입력칸에 포커스한 채 창이 100행부터로 밀려도 행 5 는 DOM 에 남고, blur 하면 빠진다", async () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 400 });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => ({ top: 100 - window.scrollY }) as DOMRect);
    const { roles } = classifyRoles(props);
    render(
      <TableView
        flat
        properties={props}
        roles={roles}
        rows={rows}
        colorMode={"soft" as never}
        onUpdate={noop}
        onAddRow={noop}
        onDeleteRow={noop}
        onOpenRow={noop}
      />,
    );
    await act(frame);
    const input = row(5)!.querySelector("input")!;
    act(() => input.focus());
    expect(document.activeElement).toBe(input);

    // 상대 스크롤 4400px = 110행 → start = 110 - overscan 10 = 100
    Object.defineProperty(window, "scrollY", { configurable: true, value: 4500 });
    await act(async () => {
      window.dispatchEvent(new Event("scroll"));
      await frame();
    });
    expect(row(100)).not.toBeNull();
    expect(row(99)).toBeNull();
    expect(row(50)).toBeNull();
    expect(row(5)).not.toBeNull();
    expect(row(5)!.querySelector("input")).toBe(input); // 같은 요소 — 다시 마운트되지 않았다
    expect(document.activeElement).toBe(input);

    // 스페이서가 나뉘어 전체 높이(300행분)는 유지된다
    const pads = [...document.querySelectorAll<HTMLElement>("tr.ws-table-spacer")].map((el) => parseFloat(el.style.height));
    const rendered = document.querySelectorAll("tr[data-row-id]").length;
    expect(pads.reduce((a, b) => a + b, 0) + rendered * 40).toBe(300 * 40);

    act(() => input.blur());
    expect(row(5)).toBeNull();
    spy.mockRestore();
  });
});

describe("TableView 가상 스크롤 해제 플래그", () => {
  const renderTable = () => {
    const { roles } = classifyRoles(props);
    render(
      <TableView
        flat
        properties={props}
        roles={roles}
        rows={rows}
        colorMode={"soft" as never}
        onUpdate={noop}
        onAddRow={noop}
        onDeleteRow={noop}
        onOpenRow={noop}
      />,
    );
  };
  const rendered = () => document.querySelectorAll("tbody tr.ws-table-row").length;

  it("기본은 150행을 넘으면 창만 그린다", () => {
    renderTable();
    expect(rendered()).toBeLessThan(300);
    expect(document.querySelector("tr.ws-table-spacer")).not.toBeNull();
  });

  it("localStorage ws-table-virtual=0 이면 300행을 전부 그린다(찾기·Tab 이 닿게)", () => {
    localStorage.setItem("ws-table-virtual", "0");
    try {
      renderTable();
      expect(rendered()).toBe(300);
      expect(document.querySelector("tr.ws-table-spacer")).toBeNull();
    } finally {
      localStorage.removeItem("ws-table-virtual");
    }
  });

  it("?virtual=0 이어도 전부 그린다", () => {
    window.history.replaceState(null, "", "/p/db1?virtual=0");
    try {
      renderTable();
      expect(rendered()).toBe(300);
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });
});
