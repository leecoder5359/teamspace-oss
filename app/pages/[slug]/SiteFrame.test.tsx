// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import SiteFrame from "./SiteFrame";

afterEach(cleanup);

// 좁은 화면에서 제목보다 이메일이 먼저 줄고, 로그아웃은 누르기 쉬운 높이(U-26).
describe("SiteFrame 상단 바", () => {
  it("이메일은 줄어들 수 있고(minWidth 0) 폭의 40% 를 넘지 않는다. 로그아웃 버튼은 최소 36px", () => {
    render(<SiteFrame title="보고서" email="guest@example.com" src="/pub/x/index.html" onSwitch={async () => {}} />);
    const email = screen.getByText("guest@example.com");
    expect(email.style.minWidth).toBe("0px");
    expect(email.style.maxWidth).toBe("40%");
    expect(screen.getByRole("button", { name: "로그아웃" }).style.minHeight).toBe("36px");
  });
});
