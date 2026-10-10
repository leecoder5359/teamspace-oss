import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { page: { count: vi.fn(), findMany: vi.fn() }, decision: { findMany: vi.fn() } } }));
vi.mock("@/lib/llm", () => ({ synthesizeAnswer: vi.fn(async () => null) }));
vi.mock("@/lib/pageGuard", () => ({
  loadAccess: vi.fn(async () => ({})),
  visibleOnly: vi.fn((_i: unknown, rows: { id: string }[]) => rows.filter((r) => r.id !== "h")),
}));

import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { GET } from "./route";

const m = (f: unknown) => f as Mock;
const at = new Date("2026-10-09T00:00:00Z");
const TREE = [
  { id: "f", parentId: null, archivedAt: at },
  { id: "c", parentId: "f", archivedAt: null },
  { id: "a", parentId: null, archivedAt: null },
];
const DOCS = [
  { id: "a", title: "배포 절차", markdown: "배포 롤백" },
  { id: "c", title: "옛 배포", markdown: "배포 롤백" },
];

describe("GET /api/ask — 보관 문서는 근거에서 늘 빠진다", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor" });
    m(prisma.decision.findMany).mockResolvedValue([]);
    m(prisma.page.count).mockResolvedValue(1);
    m(prisma.page.findMany).mockImplementation(async (args: { where: { kind?: string } }) => (args.where.kind ? DOCS : TREE));
  });
  it("보관 폴더 아래 문서는 sources 에 없다(archived=1 도 무시)", async () => {
    for (const url of ["http://t/api/ask?q=배포", "http://t/api/ask?q=배포&archived=1"]) {
      const { sources } = await (await GET(new Request(url))).json();
      expect(sources.map((s: { id: string }) => s.id)).toEqual(["a"]);
    }
  });
});
