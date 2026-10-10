// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render as mount, fireEvent, cleanup } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarTree, type SidebarTreeProps } from "./SidebarTree";
import { groupByProject, defaultCollapsed, type FlatPage } from "./treeModel";

const page = (id: string, over: Partial<FlatPage> = {}): FlatPage => ({
  id, title: id, icon: null, parentId: null, position: 0, kind: "doc", projectId: "p1", docType: null, ...over,
});
const projects = [{ id: "p1", name: "반장" }, { id: "p2", name: "로요" }];
const noop = async () => {};

function render(flat: FlatPage[], collapsed?: Set<string>, over: Partial<SidebarTreeProps> = {}) {
  const groups = groupByProject(flat, projects);
  return renderToStaticMarkup(
    <SidebarTree
      groups={groups}
      collapsed={collapsed ?? new Set()}
      ready
      toggle={() => {}}
      activeId={null}
      createPage={async () => null}
      createBoard={noop}
      busy={false}
      loaded
      move={noop}
      rename={noop}
      remove={noop}
      toggleFavorite={noop}
      setDocType={noop}
      {...over}
    />,
  );
}

describe("SidebarTree", () => {
  it("기본 접힘이면 현재 프로젝트 그룹만 펼쳐진다", () => {
    const flat = [page("doc-a", { projectId: "p1" }), page("doc-b", { projectId: "p2" })];
    const collapsed = defaultCollapsed(groupByProject(flat, projects), "p1");
    const html = render(flat, collapsed);
    expect(html).toContain('href="/p/doc-a"');
    expect(html).not.toContain('href="/p/doc-b"');
  });

  it("폴더는 📁 과 하위 건수 배지를 그린다", () => {
    const flat = [page("folder", { title: "트랙", childCount: 2 }), page("c1", { parentId: "folder" }), page("c2", { parentId: "folder", position: 1 })];
    const html = render(flat);
    expect(html).toMatch(/<span class="ws-tree-icon">📁<\/span>/);
    expect(html).toContain('<span class="ws-nav-count">2</span>');
  });

  it("태스크 설명 폴더 행은 흐리게(ws-tree-row--muted) 그린다", () => {
    const flat = [page("tn", { title: "태스크 설명" }), page("n1", { parentId: "tn", docType: "task_note" })];
    const html = render(flat);
    const row = html.slice(html.lastIndexOf("<div", html.indexOf('href="/p/tn"')), html.indexOf('href="/p/tn"'));
    expect(row).toContain("ws-tree-row--muted");
    // 하위 문서 행은 흐리게 하지 않는다
    const child = html.slice(html.lastIndexOf("<div", html.indexOf('href="/p/n1"')), html.indexOf('href="/p/n1"'));
    expect(child).not.toContain("ws-tree-row--muted");
  });

  it("뿌리 문서 13개면 12행과 '1개 더 보기' 버튼", () => {
    const flat = Array.from({ length: 13 }, (_, i) => page(`d${i}`, { position: i }));
    const html = render(flat);
    const rows = html.match(/href="\/p\/d\d+"/g) ?? [];
    expect(rows).toHaveLength(12);
    expect(html).not.toContain('href="/p/d12"');
    expect(html).toContain('<button class="ws-tree-more">1개 더 보기</button>');
  });

  it("문서 행은 docType 아이콘을 그린다", () => {
    const html = render([page("r", { docType: "report" })]);
    expect(html).toContain('<span class="ws-tree-icon">📊</span>');
  });

  it("접힘이 정해지기 전(ready=false)엔 그룹 머리만, 정해지면 현재 프로젝트 본문만 그린다", () => {
    const flat = [page("doc-a", { projectId: "p1" }), page("doc-b", { projectId: "p2" })];
    const before = render(flat, new Set(), { ready: false });
    expect(before).toContain(">반장</button>");
    expect(before).toContain(">로요</button>");
    expect(before).not.toContain('<ul class="ws-tree">');
    expect(before).not.toContain('href="/p/doc-a"');

    const after = render(flat, defaultCollapsed(groupByProject(flat, projects), "p1"), { ready: true });
    expect(after.match(/<ul class="ws-tree">/g)).toHaveLength(1);
    expect(after).toContain('href="/p/doc-a"');
    expect(after).not.toContain('href="/p/doc-b"');
  });

});

describe("SidebarTree 우클릭 메뉴", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("화면 아래·오른쪽 끝에서 열어도 메뉴를 화면 안으로 당긴다", () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(600);
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 200, height: 400, top: 0, left: 0, right: 200, bottom: 400, x: 0, y: 0, toJSON: () => ({}) });
    const flat = [page("doc-a")];
    const { container } = mount(
      <SidebarTree groups={groupByProject(flat, projects)} collapsed={new Set()} ready toggle={() => {}} activeId={null}
        createPage={async () => null} createBoard={noop} busy={false} loaded move={noop} rename={noop} remove={noop} toggleFavorite={noop} setDocType={noop} />,
    );
    const row = container.querySelector('a[href="/p/doc-a"]')!.closest(".ws-tree-row")!;
    fireEvent.contextMenu(row, { clientX: 790, clientY: 590 });
    const menu = container.querySelector<HTMLElement>(".ws-ctx-menu")!;
    expect(menu.style.top).toBe("192px"); // 600 - 400 - 8
    expect(menu.style.left).toBe("592px"); // 800 - 200 - 8
  });

  describe("이름 변경 UI", () => {
    afterEach(cleanup);
    function open(rename: SidebarTreeProps["rename"]) {
      const r = mount(
        <SidebarTree groups={groupByProject([page("doc-a", { title: "원래 제목" })], projects)} collapsed={new Set()} ready toggle={() => {}} activeId={null}
          createPage={async () => null} createBoard={noop} busy={false} loaded move={noop} rename={rename} remove={noop} toggleFavorite={noop} setDocType={noop} />,
      );
      fireEvent.click(r.container.querySelector<HTMLElement>('button[title="더보기"]')!);
      fireEvent.click(Array.from(r.container.querySelectorAll<HTMLElement>(".ws-ctx-item")).find((b) => b.textContent?.trim() === "이름 변경")!);
      return r.container.querySelector<HTMLInputElement>("input.ws-tree-rename")!;
    }

    it("메뉴 → 이름 변경 → 입력 → Enter 면 rename(id, title) 을 부른다", () => {
      const rename = vi.fn(async () => {});
      const input = open(rename);
      expect(input.value).toBe("원래 제목");
      fireEvent.change(input, { target: { value: "  새 제목  " } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(rename).toHaveBeenCalledTimes(1);
      expect(rename).toHaveBeenCalledWith("doc-a", "새 제목");
    });

    it("Escape 는 rename 을 부르지 않고 입력을 닫는다", () => {
      const rename = vi.fn(async () => {});
      const input = open(rename);
      fireEvent.change(input, { target: { value: "버릴 제목" } });
      fireEvent.keyDown(input, { key: "Escape" });
      expect(document.querySelector("input.ws-tree-rename")).toBeNull();
      expect(rename).not.toHaveBeenCalled();
    });
  });
});
