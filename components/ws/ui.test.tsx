// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { ProgressBar, StatusPill } from "./ui";

/* RTL 컴포넌트 테스트 스타터 — 순수 표현 컴포넌트.
   per-file `@vitest-environment jsdom`라 기존 node 단위 테스트엔 영향 없음. */

afterEach(cleanup);

describe("ProgressBar", () => {
  it("값을 정수 퍼센트 라벨로 렌더한다", () => {
    const { container } = render(<ProgressBar value={49.6} />);
    expect(container.querySelector(".ds-progress-label")?.textContent).toBe("50%");
  });

  it("0~100으로 클램프한다", () => {
    expect(render(<ProgressBar value={150} />).container.querySelector(".ds-progress-label")?.textContent).toBe("100%");
    expect(render(<ProgressBar value={-20} />).container.querySelector(".ds-progress-label")?.textContent).toBe("0%");
  });

  it("진행도에 따라 tone 클래스를 바꾼다", () => {
    expect(render(<ProgressBar value={100} />).container.querySelector(".ds-progress-fill")?.className).toContain("ds-progress-done");
    expect(render(<ProgressBar value={70} />).container.querySelector(".ds-progress-fill")?.className).toContain("ds-progress-mid");
    expect(render(<ProgressBar value={10} />).container.querySelector(".ds-progress-fill")?.className).toContain("ds-progress-low");
  });

  it("showLabel=false면 라벨을 숨긴다", () => {
    const { container } = render(<ProgressBar value={50} showLabel={false} />);
    expect(container.querySelector(".ds-progress-label")).toBeNull();
  });
});

describe("StatusPill", () => {
  it("라벨 텍스트를 렌더한다", () => {
    const { container } = render(<StatusPill label="진행 중" color="#2F62FF" />);
    expect(container.textContent).toContain("진행 중");
    expect(container.querySelector(".ds-status-pill")).not.toBeNull();
  });
});
