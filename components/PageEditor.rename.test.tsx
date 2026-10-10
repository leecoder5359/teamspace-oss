// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, screen, waitFor, fireEvent } from "@testing-library/react";

// BlockNote 는 jsdom 에서 돌지 않는다 — 제목 저장 → 중복 안내 경로만 보려고 최소 가짜로 바꾼다.
const fakeEditor = { document: [] as unknown[], replaceBlocks: vi.fn() };
vi.mock("@blocknote/core/fonts/inter.css", () => ({}));
vi.mock("@blocknote/mantine/style.css", () => ({}));
vi.mock("@blocknote/mantine", () => ({ BlockNoteView: () => null }));
vi.mock("@blocknote/react", () => ({
  SuggestionMenuController: () => null,
  getDefaultReactSlashMenuItems: () => [],
  useCreateBlockNote: () => fakeEditor,
}));
vi.mock("./editor/schema", () => ({ wsSchema: {}, CALLOUT_KINDS: [] }));
vi.mock("@/lib/pagesClient", () => ({ getPages: async () => ({ ok: true, data: { pages: [] } }) }));
const renameCollides = vi.fn();
vi.mock("@/lib/renameDuplicate", () => ({
  DUPLICATE_RENAME_NOTICE: "같은 프로젝트에 같은 제목 문서가 있어요",
  renameCollides: (id: string) => renameCollides(id),
}));

import PageEditor from "./PageEditor";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  renameCollides.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init?: RequestInit) =>
      init?.method === "PUT" ? json({ rev: 2 }) : json({ page: { title: "원래 제목", rev: 1 }, markdown: "" }),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function editTitle(next: string) {
  const input = (await screen.findByDisplayValue("원래 제목")) as HTMLInputElement;
  fireEvent.change(input, { target: { value: next } });
  fireEvent.blur(input);
}

describe("PageEditor 제목 저장 — 중복 제목 안내", () => {
  it("저장 뒤 helper 가 겹침을 알리면 안내를 보인다", async () => {
    renameCollides.mockResolvedValue(true);
    render(<PageEditor pageId="d1" />);
    await editTitle("겹치는 제목");
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("같은 프로젝트에 같은 제목 문서가 있어요"));
    expect(renameCollides).toHaveBeenCalledWith("d1");
  });

  it("겹치지 않으면 안내가 없다", async () => {
    renameCollides.mockResolvedValue(false);
    render(<PageEditor pageId="d1" />);
    await editTitle("고유한 제목");
    await waitFor(() => expect(renameCollides).toHaveBeenCalled());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("제목 입력을 다시 고치면 안내가 사라진다", async () => {
    renameCollides.mockResolvedValue(true);
    render(<PageEditor pageId="d1" />);
    await editTitle("겹치는 제목");
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue("겹치는 제목"), { target: { value: "겹치는 제목2" } });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
