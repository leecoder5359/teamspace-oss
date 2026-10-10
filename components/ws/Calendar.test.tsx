import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import Calendar from "./Calendar";

describe("Calendar — 로드 전 스켈레톤", () => {
  it("헤더(캘린더·뷰 전환·스코프 토글)는 즉시 보이고 그리드 자리는 스켈레톤이다", () => {
    const html = renderToStaticMarkup(<Calendar />);
    expect(html).toContain("캘린더");
    for (const l of ["오늘", "마감", "문서", "리마인더"]) expect(html).toContain(l);
    // 월 뷰 6주 × 7일 = 실제 그리드와 같은 42칸
    expect((html.match(/ws-skeleton/g) ?? []).length).toBe(42);
  });
});
