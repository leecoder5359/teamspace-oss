// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarQuick } from "./SidebarQuick";

const item = (id: string, title: string) => ({ pageId: id, title, kind: "doc" as const, docType: "design" as const, projectId: "p" });

describe("SidebarQuick", () => {
  it("즐겨찾기가 비면 안내 한 줄, 최근은 현재 페이지를 뺀다", () => {
    const html = renderToStaticMarkup(<SidebarQuick favorites={[]} recents={[item("a", "A"), item("b", "B")]} activeId="a" onNavigate={() => {}} />);
    expect(html).toContain("★ 로 고정하세요");
    expect(html).toContain(">B<");
    expect(html).not.toContain(">A<");
  });
  it("docType 아이콘을 그린다", () => {
    const html = renderToStaticMarkup(<SidebarQuick favorites={[item("a", "A")]} recents={[]} activeId={null} onNavigate={() => {}} />);
    expect(html).toContain("📐");
  });
});
