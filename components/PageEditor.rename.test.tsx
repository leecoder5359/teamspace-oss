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

describe("PageEditor 제목 — 화면 제목 구조(U-29)", () => {
  it("편집 가능한 제목 입력이 h1 안에 있다", async () => {
    render(<PageEditor pageId="d1" />);
    const input = await screen.findByDisplayValue("원래 제목");
    expect(input.closest("h1")).not.toBeNull();
    expect(document.querySelectorAll("h1")).toHaveLength(1);
  });
});

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

describe("PageEditor — 서버 미리 읽기(B1)", () => {
  it("initial 이 있으면 첫 마운트는 GET 없이 그 본문·rev 로 시작하고, 저장은 그 rev 를 baseRev 로 보낸다", async () => {
    const initial = { page: { id: "d9", title: "미리 읽은 제목", icon: null, parentId: null, kind: "doc", rev: 5 }, markdown: "", nonce: "nonce-d9" };
    render(<PageEditor pageId="d9" initial={initial} />);
    const input = (await screen.findByDisplayValue("미리 읽은 제목")) as HTMLInputElement;
    // 앞 테스트의 디바운스 저장 타이머가 늦게 터질 수 있다 — 이 문서(d9) 호출만 본다.
    const f = fetch as unknown as ReturnType<typeof vi.fn>;
    const mine = () => f.mock.calls.filter(([u]) => String(u).includes("/api/pages/d9"));
    expect(mine().filter(([, init]) => !init?.method || init.method === "GET")).toHaveLength(0);
    fireEvent.change(input, { target: { value: "바뀐 제목" } });
    fireEvent.blur(input);
    await waitFor(() => expect(mine().some(([, init]) => init?.method === "PUT")).toBe(true));
    const put = mine().find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(put[1].body as string).baseRev).toBe(5);

    // 같은 미리 읽기로 다시 마운트(모드 전환·뒤로 가기)되면 API 에서 새로 받는다
    cleanup();
    render(<PageEditor pageId="d9" initial={initial} />);
    await screen.findByDisplayValue("원래 제목");
  });
});
