// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { TableView, classifyRoles, type DbProperty, type DbRow } from "../DatabaseView";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const props: DbProperty[] = [{ id: "t", name: "제목", type: "text", config: null, position: 0 }];
const rows: DbRow[] = [
  { id: "r1", props: { t: "첫 행" }, position: 0 },
  { id: "r2", props: { t: "" }, position: 1 },
];
const noop = () => {};

function renderTable(onDeleteRow: (id: string) => void) {
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
      onDeleteRow={onDeleteRow}
      onOpenRow={noop}
    />,
  );
}
const delBtn = (id: string) => document.querySelectorAll<HTMLButtonElement>("tr.ws-table-row .ws-row-del")[rows.findIndex((r) => r.id === id)];

describe("TableView 행 삭제 확인(U-1)", () => {
  it("행 제목을 넣어 확인을 묻고, 확인하면 삭제한다", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const onDelete = vi.fn();
    renderTable(onDelete);
    fireEvent.click(delBtn("r1"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('"첫 행"'));
    expect(onDelete).toHaveBeenCalledWith("r1");
  });

  it("취소하면 삭제하지 않는다", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const onDelete = vi.fn();
    renderTable(onDelete);
    fireEvent.click(delBtn("r1"));
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("제목이 비어 있으면 '제목 없음' 으로 묻는다", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderTable(vi.fn());
    fireEvent.click(delBtn("r2"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('"제목 없음"'));
  });
});
