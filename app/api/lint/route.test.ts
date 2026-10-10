import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { page: { count: vi.fn(), findMany: vi.fn() } } }));
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
  { id: "b", parentId: null, archivedAt: null },
  { id: "h", parentId: null, archivedAt: at },
];
const doc = (id: string, title: string, markdown: string, parentId: string | null = null) =>
  ({ id, title, markdown, parentId, projectId: null as string | null, docType: null });
const DOCS = [
  doc("f", "보관 폴더", ""),
  doc("c", "옛 문서", "[[없는 문서]]", "f"),
  doc("a", "활성", "[[옛 문서]] [[숨김]] [[B]]"),
  doc("b", "B", "[[활성]]"),
  doc("h", "숨김", ""),
];

const lintOf = async (docs: ReturnType<typeof doc>[], tree: { id: string; parentId: string | null; archivedAt: Date | null }[]) => {
  m(prisma.page.count).mockResolvedValue(tree.filter((t) => t.archivedAt).length);
  m(prisma.page.findMany).mockImplementation(async (args: { where: { kind?: string } }) => (args.where.kind ? docs : tree));
  return (await GET()).json();
};

describe("GET /api/lint — 보관 문서와의 관계", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor" });
  });
  it("(a) 활성 문서의 유일한 링크가 보관 문서면 고아가 아니다 — 보관 문서 자신은 보고에서 빠진다", async () => {
    const res = await lintOf(
      [doc("a", "활성", "[[옛 문서]]"), doc("o", "옛 문서", "")],
      [{ id: "a", parentId: null, archivedAt: null }, { id: "o", parentId: null, archivedAt: at }],
    );
    expect(res.orphans).toEqual([]);
    expect(res.broken).toEqual([]);
  });
  it("(b) 자식이 모두 보관된 활성 뿌리 문서는 뿌리 문서 목록에 나오지 않는다", async () => {
    const proj = (id: string, title: string, parentId: string | null) => ({ ...doc(id, title, "", parentId), projectId: "p1" });
    const res = await lintOf(
      [proj("r", "활성 폴더", null), proj("k", "보관 자식", "r"), proj("z", "진짜 뿌리 문서", null)],
      [{ id: "r", parentId: null, archivedAt: null }, { id: "k", parentId: "r", archivedAt: at }, { id: "z", parentId: null, archivedAt: null }],
    );
    expect(res.rootDocs.map((r: { id: string }) => r.id)).toEqual(["z"]);
  });
});

describe("GET /api/lint — 보관 문서는 점검 대상이 아니다", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor" });
    m(prisma.page.count).mockResolvedValue(2);
    m(prisma.page.findMany).mockImplementation(async (args: { where: { kind?: string } }) => (args.where.kind ? DOCS : TREE));
  });
  it("보관 문서는 출처·고아에서 빠지고, 보관 문서로 가는 링크는 깨진 링크가 아니다", async () => {
    const res = await (await GET()).json();
    // c 의 깨진 링크는 보고하지 않는다. a→옛 문서(보관)는 깨진 게 아니다. a→숨김(못 봄)은 깨진 링크로 남는다(기존 D3 동작).
    expect(res.broken).toEqual([{ sourceId: "a", sourceTitle: "활성", target: "숨김" }]);
    expect(res.orphans.map((o: { id: string }) => o.id)).toEqual([]);
  });
});
