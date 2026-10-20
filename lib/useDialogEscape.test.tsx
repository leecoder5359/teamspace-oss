// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { useDialogEscape } from "./useDialogEscape";

afterEach(cleanup);

function Harness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const close = () => {
    onClose?.();
    setOpen(false);
  };
  const closeRef = useDialogEscape(open, close);
  return (
    <>
      <button onClick={() => setOpen(true)}>열기</button>
      {open && (
        <div role="dialog">
          <button ref={closeRef} onClick={close}>닫기</button>
        </div>
      )}
    </>
  );
}

describe("useDialogEscape", () => {
  it("열리면 닫기 버튼에 포커스, Escape 로 닫히고 연 요소로 포커스를 되돌린다", () => {
    const onClose = vi.fn();
    const { getByText, queryByRole } = render(<Harness onClose={onClose} />);
    const opener = getByText("열기");
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(getByText("닫기"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("닫혀 있으면 Escape 를 무시한다", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("다른 키는 닫지 않는다", () => {
    const onClose = vi.fn();
    const { getByText } = render(<Harness onClose={onClose} />);
    fireEvent.click(getByText("열기"));
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("useDialogEscape 가장자리", () => {
  it("연 요소가 닫기 전에 DOM 에서 빠지면 던지지 않고 포커스를 억지로 옮기지 않는다", () => {
    function Gone() {
      const [open, setOpen] = useState(false);
      const [showOpener, setShowOpener] = useState(true);
      const closeRef = useDialogEscape(open, () => setOpen(false));
      return (
        <>
          {showOpener && <button onClick={() => setOpen(true)}>열기</button>}
          <button onClick={() => setShowOpener(false)}>지우기</button>
          {open && <button ref={closeRef}>닫기</button>}
        </>
      );
    }
    const { getByText } = render(<Gone />);
    const opener = getByText("열기");
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(getByText("지우기"));
    expect(opener.isConnected).toBe(false);
    const focusSpy = vi.spyOn(opener, "focus");
    expect(() => fireEvent.keyDown(document, { key: "Escape" })).not.toThrow();
    expect(focusSpy).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(opener);
  });

  it("닫힌 뒤에는 리스너가 없어 Escape 가 onClose 를 부르지 않는다", () => {
    const onClose = vi.fn();
    const { getByText } = render(<Harness onClose={onClose} />);
    fireEvent.click(getByText("열기"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("열린 동안 onClose 가 바뀌면 최신 것을 부른다", () => {
    const first = vi.fn();
    const second = vi.fn();
    function Probe({ onClose }: { onClose: () => void }) {
      useDialogEscape(true, onClose);
      return null;
    }
    const { rerender } = render(<Probe onClose={first} />);
    rerender(<Probe onClose={second} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});
