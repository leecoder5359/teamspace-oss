import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

/* 개수는 count() 로 — 목록 take(문서 50·결정/리스크 30·용어 100·레슨 500)에 묶이지 않는다.
   brief 는 목록을 읽지 않고, 문서 개수의 가시성 필터는 where(id notIn)로 들어간다. */

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/pageGuard", () => ({ loadAccess: vi.fn(), pageAccess: () => "view", projectAccess: () => "view", visibleOnly: (_i: unknown, r: unknown[]) => r }));
vi.mock("@/lib/graphLoad", () => ({ loadGraph: vi.fn() }));
vi.mock("@/lib/prisma", () => {
  const fm = () => ({ findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null), count: vi.fn(async () => 0) });
  return { prisma: { workspaceRouteRule: fm(), project: fm(), workspace: fm(), page: fm(), dbProperty: fm(), dbRow: fm(), decision: fm(), risk: fm(), glossaryTerm: fm(), lesson: fm(), envTarget: fm() } };
});

import { requireCtx } from "@/lib/workspace";
import { loadAccess } from "@/lib/pageGuard";
import { loadGraph } from "@/lib/graphLoad";
import { prisma } from "@/lib/prisma";
import { buildAccessIndex } from "@/lib/pageAccess";
import { GET } from "./route";

const m = (f: unknown) => f as Mock;
const db = () => prisma as unknown as Record<string, { findMany: Mock; count: Mock }>;
type CountArg = { where: { kind?: string; archivedAt?: unknown; id?: { notIn: string[] } } };

describe("GET /api/context — 개수는 count()", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor" });
    m(loadGraph).mockResolvedValue({ nodes: [], edges: [] });
    // 남이 만든 restricted 문서 하나 — 이 뷰어에겐 none
    m(loadAccess).mockResolvedValue(
      buildAccessIndex({
        viewer: { userId: "u1", teamId: null, role: "editor" },
        pages: [
          { id: "open", parentId: null, projectId: null, createdById: "u2", visibility: "inherit" },
          { id: "secret", parentId: null, projectId: null, createdById: "u2", visibility: "restricted" },
        ],
        projects: [],
        pageGrants: [],
        projectGrants: [],
      }),
    );
    const p = db();
    p.page.count.mockImplementation(async (a: CountArg) => (a.where.kind === "doc" ? 120 : 0));
    p.page.findMany.mockImplementation(async (a: CountArg) =>
      a.where.kind === "doc" ? Array.from({ length: 50 }, (_, i) => ({ id: `d${i}`, title: `문서 ${i}`, updatedAt: new Date(0) })) : [],
    );
    p.decision.count.mockResolvedValue(45);
    p.risk.count.mockResolvedValue(31);
    p.glossaryTerm.count.mockResolvedValue(150);
    p.lesson.count.mockResolvedValue(700);
  });

  it("brief 는 목록을 읽지 않고 정확한 개수를 쓴다", async () => {
    const body = await (await GET(new Request("http://t/api/context?brief=1&format=json"))).json();
    expect(body.counts).toMatchObject({ docs: 120, decisions: 45, risks: 31, glossary: 150, lessons: 700 });
    expect(body.markdown).toContain("문서 120 · 결정 45 · 리스크 31 · 용어 150");
    const docListReads = db().page.findMany.mock.calls.filter(([a]) => (a as CountArg).where.kind === "doc");
    expect(docListReads).toHaveLength(0);
    for (const k of ["decision", "risk", "glossaryTerm"]) expect(db()[k].findMany).not.toHaveBeenCalled();
  });

  it("compact·full 헤더도 take 에 묶이지 않은 개수", async () => {
    const md = await (await GET(new Request("http://t/api/context?compact=1"))).text();
    expect(md).toContain("## 문서 (120)");
    expect(md).toContain("## 결정 — 승인됨 (45)");
    expect(md).toContain("## 리스크 — 열림 (31)");
    expect(md).toContain("## 용어집 (150)");
  });

  it("볼 수 없는 문서는 count where 의 id notIn 으로 빠진다", async () => {
    await GET(new Request("http://t/api/context?brief=1"));
    const docCount = db().page.count.mock.calls.map(([a]) => a as CountArg).find((a) => a.where.kind === "doc");
    expect(docCount?.where.id?.notIn).toEqual(["secret"]);
  });

  it("admin 은 숨김 없음(where 에 notIn 을 싣지 않는다)", async () => {
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "admin" });
    m(loadAccess).mockResolvedValue(
      buildAccessIndex({
        viewer: { userId: "u1", teamId: null, role: "admin" },
        pages: [{ id: "secret", parentId: null, projectId: null, createdById: "u2", visibility: "restricted" }],
        projects: [], pageGrants: [], projectGrants: [],
      }),
    );
    await GET(new Request("http://t/api/context?brief=1"));
    const docCount = db().page.count.mock.calls.map(([a]) => a as CountArg).find((a) => a.where.kind === "doc");
    expect(docCount?.where.id).toBeUndefined();
  });
});
