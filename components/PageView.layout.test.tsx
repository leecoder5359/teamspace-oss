// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("next/dynamic", () => ({ default: () => () => <div data-testid="editor" /> }));
vi.mock("./DocToc", () => ({ default: () => <div /> }));
vi.mock("./Breadcrumb", () => ({ default: () => <div /> }));
vi.mock("./ws/PresenceBar", () => ({ default: () => <div /> }));
vi.mock("./ws/SharePanel", () => ({ default: () => <div data-testid="share" /> }));

import PageView from "./PageView";

describe("PageView 레이아웃", () => {
  afterEach(cleanup);
  it.each([false, true])("공유 패널은 본문 칼럼 안 .ws-share-panel 에 있다 (fileBacked=%s)", (fileBacked) => {
    const { getByTestId } = render(<PageView pageId="p1" fileBacked={fileBacked} />);
    const share = getByTestId("share");
    const wrap = share.closest(".ws-share-panel");
    expect(wrap).not.toBeNull();
    const editor = getByTestId("editor");
    expect(wrap!.parentElement).toBe(editor.parentElement);
  });
});
