// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import ViewToolbar from "./ViewToolbar";
import FilterPanel from "./FilterPanel";
import type { DbProperty } from "./useBoardData";

afterEach(cleanup);

const status: DbProperty = {
  id: "s", name: "상태", type: "select", position: 1,
  config: { options: [{ id: "o1", name: "진행중", color: "blue" }, { id: "o2", name: "완료", color: "green" }] },
};
const title: DbProperty = { id: "t", name: "제목", type: "text", config: null, position: 0 };
const META = [{ key: "createdAt", label: "만든 시각" }, { key: "updatedAt", label: "수정 시각" }] as const;
type K = (typeof META)[number]["key"];

function toolbar(over: Partial<React.ComponentProps<typeof ViewToolbar<K>>> = {}) {
  const fns = {
    onQueryChange: vi.fn(), onQuickFilterChange: vi.fn(), onOpenOnlyChange: vi.fn(), onClear: vi.fn(),
    onFilterChange: vi.fn(), onMetaChange: vi.fn(), onColorModeChange: vi.fn(), onDensityChange: vi.fn(),
  };
  render(
    <ViewToolbar<K>
      query="" selectProps={[status]} quickFilters={{}} showOpenOnly openOnly closedHidden={2}
      shownCount={3} totalCount={9} properties={[title, status]} filter={null} viewType="table"
      metaColumns={META} meta={[]} colorMode="soft" density="cozy"
      {...fns} {...over}
    />,
  );
  return fns;
}

describe("ViewToolbar (T-4b)", () => {
  it("검색·빠른 필터·열린 것만 토글이 콜백으로 나간다", () => {
    const f = toolbar();
    fireEvent.change(screen.getByPlaceholderText("검색…"), { target: { value: "x" } });
    expect(f.onQueryChange).toHaveBeenCalledWith("x");
    fireEvent.change(screen.getByDisplayValue("상태: 전체"), { target: { value: "o2" } });
    expect(f.onQuickFilterChange).toHaveBeenCalledWith("s", "o2");
    expect(screen.getByText("완료·취소 2건 숨김")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /열린 것만/ }));
    expect(f.onOpenOnlyChange).toHaveBeenCalledWith(false);
  });

  it("초기화 버튼은 검색·필터가 있을 때만, 라벨은 shownCount/totalCount", () => {
    toolbar();
    expect(screen.queryByText(/초기화/)).toBeNull();
    cleanup();
    const f = toolbar({ query: "x" });
    fireEvent.click(screen.getByRole("button", { name: "초기화 (3/9)" }));
    expect(f.onClear).toHaveBeenCalled();
  });

  it("칸반이면 메타 열을 숨기고 색상 모드를 낸다, 표면 반대", () => {
    toolbar({ viewType: "kanban", showOpenOnly: false });
    expect(screen.queryByText(/메타 열/)).toBeNull();
    expect(screen.queryByText("열린 것만")).toBeNull();
    expect(screen.getByRole("group", { name: "카드 색상 모드" })).toBeTruthy();
    cleanup();
    const f = toolbar({ meta: ["createdAt"] });
    expect(screen.queryByRole("group", { name: "카드 색상 모드" })).toBeNull();
    expect(screen.getByText("메타 열 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "수정 시각" }));
    expect(f.onMetaChange).toHaveBeenCalledWith(["createdAt", "updatedAt"]);
    fireEvent.click(screen.getByRole("button", { name: "넓게" }));
    expect(f.onDensityChange).toHaveBeenCalledWith("roomy");
  });
});

describe("FilterPanel (T-4b)", () => {
  it("+ 조건 추가는 첫 속성·그 종류의 첫 연산자로 규칙을 붙인다", () => {
    const onChange = vi.fn();
    render(<FilterPanel properties={[title, status]} filter={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "+ 조건 추가" }));
    expect(onChange).toHaveBeenCalledWith({ conj: "and", rules: [{ propId: "t", op: expect.any(String), value: null }] });
  });

  it("규칙 값 변경·삭제·전체 해제", () => {
    const onChange = vi.fn();
    const filter = { conj: "or" as const, rules: [{ propId: "s", op: "eq" as const, value: null }] };
    render(<FilterPanel properties={[title, status]} filter={filter} onChange={onChange} />);
    expect(screen.getByText("필터 1")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("값"), { target: { value: "o1" } });
    expect(onChange).toHaveBeenLastCalledWith({ conj: "or", rules: [{ propId: "s", op: "eq", value: "o1" }] });
    fireEvent.click(screen.getByTitle("이 조건 삭제"));
    expect(onChange).toHaveBeenLastCalledWith({ conj: "or", rules: [] });
    fireEvent.click(screen.getByRole("button", { name: "전체 해제" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});
