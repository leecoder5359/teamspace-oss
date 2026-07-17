// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import MarkdownPreview from "./MarkdownPreview";

afterEach(cleanup);

describe("MarkdownPreview 표·헤딩·코드펜스", () => {
  it("GFM 표를 <table> 로 렌더하고 파이프 원본이 새지 않는다", () => {
    const md = ["| A | B |", "|---|---|", "| 1 | 2 |"].join("\n");
    const { container } = render(<MarkdownPreview markdown={md} />);
    expect(container.querySelector("table")).not.toBeNull();
    const th = container.querySelectorAll("th");
    expect(th).toHaveLength(2);
    expect(th[0].textContent).toBe("A");
    const td = container.querySelectorAll("td");
    expect(td).toHaveLength(2);
    expect(td[0].textContent).toBe("1");
    expect(container.textContent).not.toContain("|---|");
  });

  it("구분선의 정렬(:--, :-:, --:)을 셀에 반영한다", () => {
    const md = ["| L | C | R |", "|:--|:-:|--:|", "| a | b | c |"].join("\n");
    const { container } = render(<MarkdownPreview markdown={md} />);
    const th = container.querySelectorAll("th");
    expect(th[0].style.textAlign).toBe("left");
    expect(th[1].style.textAlign).toBe("center");
    expect(th[2].style.textAlign).toBe("right");
  });

  it("h4 를 헤딩으로 렌더한다(#### 리터럴 아님)", () => {
    const { container } = render(<MarkdownPreview markdown={"#### 소제목"} />);
    expect(container.querySelector("h4")?.textContent).toBe("소제목");
    expect(container.textContent).not.toContain("####");
  });

  it("코드펜스 안의 내용을 원본 그대로 보존한다", () => {
    const md = ["```", "const x = |not a table|;", "```"].join("\n");
    const { container } = render(<MarkdownPreview markdown={md} />);
    expect(container.querySelector("pre code")?.textContent).toBe("const x = |not a table|;");
    expect(container.querySelector("table")).toBeNull();
  });

  it("구분선 없는 단독 파이프 줄은 표로 취급하지 않는다", () => {
    const { container } = render(<MarkdownPreview markdown={"| 그냥 텍스트 |"} />);
    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).toContain("| 그냥 텍스트 |");
  });
});
