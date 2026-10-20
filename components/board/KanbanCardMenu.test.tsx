// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import KanbanCardMenu from "./KanbanCardMenu";

afterEach(cleanup);

const options = [
  { key: "", label: "미지정" },
  { key: "o1", label: "진행중", color: "blue" },
  { key: "o2", label: "완료", color: "green" },
];

function setup(current = "o1") {
  const onPick = vi.fn();
  const onCardClick = vi.fn();
  render(
    <div onClick={onCardClick}>
      <KanbanCardMenu cardTitle="카드 a" options={options} current={current} onPick={onPick} />
    </div>,
  );
  const trigger = screen.getByRole("button", { name: "카드 메뉴: 카드 a" });
  return { onPick, onCardClick, trigger };
}

describe("칸반 카드 메뉴 — 키보드·터치로 상태 변경(U-31)", () => {
  it("트리거는 메뉴 버튼이고, 열면 '상태 변경' 메뉴에 칸 목록이 뜨고 현재 칸에 포커스한다", () => {
    const { trigger, onCardClick } = setup();
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("menu", { name: "상태 변경" });
    const items = screen.getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual(["미지정", "진행중", "완료"]);
    expect(items[1].getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(items[1]);
    expect(menu).toBeTruthy();
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it("고르면 onPick(칸 키) 후 닫히고 포커스가 트리거로 돌아간다 — 카드 열기로 번지지 않는다", () => {
    const { trigger, onPick, onCardClick } = setup();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "완료" }));
    expect(onPick).toHaveBeenCalledWith("o2");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onCardClick).not.toHaveBeenCalled();
  });

  it("현재 칸을 다시 고르면 아무것도 바꾸지 않는다", () => {
    const { trigger, onPick } = setup();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "진행중" }));
    expect(onPick).not.toHaveBeenCalled();
  });

  it("화살표로 항목을 옮겨 다니고 Escape 로 닫으면 트리거로 포커스가 돌아간다", () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    const items = screen.getAllByRole("menuitemradio");
    fireEvent.keyDown(items[1], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2], { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("바깥을 누르면 닫힌다", () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("칸반 카드 메뉴 — 아래 공간이 없으면 위로 연다(리뷰: 잘림)", () => {
  const rect = (top: number, bottom: number) => ({ top, bottom, height: bottom - top, left: 0, right: 100, width: 100, x: 0, y: top, toJSON() {} }) as DOMRect;

  it("잘리는 조상(overflow)의 아래 끝을 넘으면 위로, 넉넉하면 아래로", () => {
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.clip) return rect(0, Number(this.dataset.clip));
      if (this.getAttribute("role") === "menu") return rect(290, 450);
      if (this.getAttribute("aria-haspopup")) return rect(260, 290);
      return rect(0, 0);
    });
    const { rerender } = render(
      <div data-clip="300" style={{ overflowY: "auto" }}>
        <KanbanCardMenu cardTitle="카드 a" options={options} current="o1" onPick={() => {}} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "카드 메뉴: 카드 a" }));
    expect(screen.getByRole("menu").dataset.placement).toBe("up");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    rerender(
      <div data-clip="900" style={{ overflowY: "auto" }}>
        <KanbanCardMenu cardTitle="카드 a" options={options} current="o1" onPick={() => {}} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "카드 메뉴: 카드 a" }));
    expect(screen.getByRole("menu").dataset.placement).toBe("down");
    spy.mockRestore();
  });
});
