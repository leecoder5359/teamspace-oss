import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { project: { findMany: vi.fn() }, page: { create: vi.fn() } } }));
vi.mock("@/lib/llm", () => ({ complete: vi.fn(async () => null) }));
vi.mock("@/lib/docFiles", () => ({
  writeDoc: vi.fn(async () => undefined),
  docFolderFor: vi.fn(() => "docs"),
  listDocFolder: vi.fn(async () => []),
  uniqueFileName: vi.fn(() => "a.md"),
}));

import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { POST } from "./route";

const m = (f: unknown) => f as Mock;

describe("POST /api/clip — 보관 프로젝트는 분류 대상이 아니다", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor" });
    m(prisma.project.findMany).mockResolvedValue([]);
  });
  it("프로젝트 목록 조회에 archivedAt: null", async () => {
    // 이후 단계(페이지 저장)는 이 테스트의 관심사가 아니다 — 목록 조회 where 만 본다.
    await POST(new Request("http://t/api/clip", { method: "POST", body: JSON.stringify({ url: "http://x", text: "t" }), headers: { "content-type": "application/json" } })).catch(() => undefined);
    expect(m(prisma.project.findMany).mock.calls[0][0].where).toEqual({ workspaceId: "w1", archivedAt: null });
  });
});
