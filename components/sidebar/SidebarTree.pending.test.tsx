// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

// useLinkStatus 는 실제 이동 중에만 pending 이 된다 — 여기서는 값을 정해 문서 링크의 표시만 본다.
const linkStatus = vi.hoisted(() => ({ pending: false }));
vi.mock("next/link", async (orig) => ({
  ...(await orig<typeof import("next/link")>()),
  useLinkStatus: () => ({ pending: linkStatus.pending }),
}));

import { SidebarTree } from "./SidebarTree";
import { groupByProject, type FlatPage } from "./treeModel";

const flat: FlatPage[] = [{ id: "doc-a", title: "느린 문서", icon: null, parentId: null, position: 0, kind: "doc", projectId: "p1", docType: null }];
const noop = async () => {};
const mount = () =>
  render(
    <SidebarTree
      groups={groupByProject(flat, [{ id: "p1", name: "반장" }])}
      collapsed={new Set()}
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
    />,
  );

afterEach(() => {
  cleanup();
  linkStatus.pending = false;
});

describe("SidebarTree 문서 링크 이동 중 표시(U-14)", () => {
  it("이동 중(pending)이면 제목을 흐리게 하고 aria-busy 를 단다", () => {
    linkStatus.pending = true;
    mount();
    const label = screen.getByText("느린 문서");
    expect(label.closest("a")?.getAttribute("href")).toBe("/p/doc-a");
    expect(label.getAttribute("aria-busy")).toBe("true");
    expect(label.style.opacity).toBe("0.5");
  });

  it("이동 중이 아니면 그대로(레이아웃 그대로, aria-busy 없음)", () => {
    mount();
    const label = screen.getByText("느린 문서");
    expect(label.getAttribute("aria-busy")).toBeNull();
    expect(label.style.opacity).toBe("1");
  });
});
