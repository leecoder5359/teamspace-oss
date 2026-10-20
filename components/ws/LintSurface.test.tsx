// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import LintSurface from "./LintSurface";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LintSurface — 문서 이동은 링크(U-18)", () => {
  it("깨진 링크 출처·고아 문서·폴더 밖 문서가 /p/<id> 링크다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      json: async () => ({
        broken: [{ sourceId: "s1", sourceTitle: "출처 문서", target: "없는 문서" }],
        orphans: [{ id: "o1", title: "고아 문서 A" }],
        rootDocs: [{ id: "r1", title: "뿌리 문서 B", projectId: "p1" }],
      }),
    })));
    render(<LintSurface />);
    expect((await screen.findByRole("link", { name: "출처 문서" })).getAttribute("href")).toBe("/p/s1");
    expect(screen.getByRole("link", { name: /고아 문서 A/ }).getAttribute("href")).toBe("/p/o1");
    expect(screen.getByRole("link", { name: /뿌리 문서 B/ }).getAttribute("href")).toBe("/p/r1");
  });
});
