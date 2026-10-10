import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { page: { count: vi.fn(), findMany: vi.fn() } } }));
vi.mock("@/lib/pageGuard", () => ({
  requirePage: vi.fn(),
  visibleOnly: vi.fn((_idx: unknown, rows: { id: string }[]) => rows.filter((r) => r.id !== "hidden")),
}));

import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { requirePage } from "@/lib/pageGuard";
import { GET } from "./route";

const m = (f: unknown) => f as Mock;
const at = new Date("2026-10-10T00:00:00Z");
const DOCS = [
  { id: "t", title: "대상", markdown: "" },
  { id: "a", title: "A", markdown: "[[대상]]" },
  { id: "c", title: "C", markdown: "[[대상]]" },
  { id: "hidden", title: "H", markdown: "[[대상]]" },
];
const TREE = [
  { id: "t", parentId: null, archivedAt: null },
  { id: "a", parentId: null, archivedAt: null },
  { id: "f", parentId: null, archivedAt: at },
  { id: "c", parentId: "f", archivedAt: null },
  { id: "hidden", parentId: null, archivedAt: null },
];

const call = async () => {
  const res = await GET(new Request("http://t/api/pages/t/backlinks"), { params: Promise.resolve({ id: "t" }) });
  return (await res.json()).backlinks.map((b: { id: string }) => b.id);
};

describe("GET /api/pages/[id]/backlinks — 보관 제외", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor" });
    m(requirePage).mockResolvedValue({ idx: {} });
    m(prisma.page.findMany).mockImplementation(async (args: { where: { kind?: string } }) => (args.where.kind ? DOCS : TREE));
  });

  it("보관 폴더 아래 문서의 역링크는 빠지고, 못 보는 문서도 빠진다", async () => {
    m(prisma.page.count).mockResolvedValue(1);
    expect(await call()).toEqual(["a"]);
  });

  it("보관 문서가 없으면 트리를 읽지 않는다", async () => {
    m(prisma.page.count).mockResolvedValue(0);
    expect(await call()).toEqual(["a", "c"]);
    expect(m(prisma.page.findMany)).toHaveBeenCalledTimes(1);
  });
});
