import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/pageGuard", () => ({ loadAccess: vi.fn(), visibleOnly: vi.fn(), projectAccess: vi.fn(), gatePage: vi.fn() }));
vi.mock("@/lib/pageAccess", () => ({ effectiveRestricted: vi.fn() }));
vi.mock("@/lib/projectRef", () => ({ resolveProjectRef: vi.fn() }));
vi.mock("@/lib/idempotency", () => ({ withIdempotency: (_r: unknown, _g: unknown, fn: () => unknown) => fn() }));
vi.mock("@/lib/graphLoad", () => ({ invalidateGraphCache: vi.fn() }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/content", () => ({ pageFilePath: vi.fn(() => "w1/p.md"), writeContent: vi.fn() }));
vi.mock("@/lib/docFiles", () => ({ writeDoc: vi.fn(), docFolderFor: vi.fn(() => "docs"), listDocFolder: vi.fn(async () => []), uniqueFileName: vi.fn(() => "t.md") }));
vi.mock("@/lib/prisma", () => ({
  prisma: { page: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() }, project: { findUnique: vi.fn() } },
}));

import { requireCtx } from "@/lib/workspace";
import { loadAccess, visibleOnly, projectAccess, gatePage } from "@/lib/pageGuard";
import { resolveProjectRef } from "@/lib/projectRef";
import { invalidateGraphCache } from "@/lib/graphLoad";
import { prisma } from "@/lib/prisma";
import { readFileSync } from "node:fs";
import { withTreeMeta } from "@/lib/pagesMeta";
import { POST } from "./route";

const m = (f: unknown) => f as Mock;
const post = (body: unknown) => new Request("http://t/api/pages", { method: "POST", body: JSON.stringify(body) });

describe("POST /api/pages — A5 그래프 캐시 무효화", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor" });
    m(visibleOnly).mockImplementation((_a: unknown, rows: unknown) => rows);
    m(loadAccess).mockResolvedValue({});
    m(resolveProjectRef).mockResolvedValue({ ok: true, projectId: null });
    m(prisma.page.findFirst).mockResolvedValue(null);
    m(prisma.page.findMany).mockResolvedValue([]);
    m(prisma.page.create).mockResolvedValue({ id: "p1", title: "T", parentId: null, kind: "doc" });
  });

  it("doc 생성 성공 → 무효화", async () => {
    expect((await POST(post({ title: "T" }))).status).toBe(200);
    expect(invalidateGraphCache).toHaveBeenCalledWith("w1");
  });

  it("database 생성 성공 → 무효화", async () => {
    m(prisma.page.create).mockResolvedValue({ id: "p1", title: "T", parentId: null, kind: "database" });
    expect((await POST(post({ title: "T", kind: "database" }))).status).toBe(200);
    expect(invalidateGraphCache).toHaveBeenCalledWith("w1");
  });

  it("template → 본문이 템플릿이고 docType 기본값은 템플릿 것", async () => {
    expect((await POST(post({ title: "설계안", template: "design" }))).status).toBe(200);
    const data = m(prisma.page.create).mock.calls[0][0].data;
    expect(data.markdown).toMatch(/^# 설계안\n\n> 템플릿: design · \d{4}-\d{2}-\d{2}/);
    expect(data.docType).toBe("design");
  });

  it("template 날짜는 KST 기준(UTC 16:00 = 다음날 01:00)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T16:00:00Z"));
    try {
      await POST(post({ title: "설계안", template: "design" }));
    } finally {
      vi.useRealTimers();
    }
    expect(m(prisma.page.create).mock.calls[0][0].data.markdown).toContain("> 템플릿: design · 2026-10-09");
  });

  it("template + 명시 docType → 명시값 우선", async () => {
    await POST(post({ title: "x", template: "plan", docType: "brief" }));
    expect(m(prisma.page.create).mock.calls[0][0].data.docType).toBe("brief");
  });

  it("template 없음 → 기존 동작(# 제목, docType null)", async () => {
    await POST(post({ title: "T" }));
    const data = m(prisma.page.create).mock.calls[0][0].data;
    expect(data.markdown).toBe("# T\n");
    expect(data.docType).toBeNull();
  });

  it("알 수 없는 template → 400", async () => {
    expect((await POST(post({ title: "T", template: "nope" }))).status).toBe(400);
    expect(prisma.page.create).not.toHaveBeenCalled();
  });

  it("4xx(권한 없는 프로젝트 403·없는 부모 400) → 무효화 안 함", async () => {
    m(resolveProjectRef).mockResolvedValueOnce({ ok: true, projectId: "pr1" });
    m(projectAccess).mockReturnValueOnce("view");
    expect((await POST(post({ title: "T", projectId: "pr1" }))).status).toBe(403);
    expect((await POST(post({ title: "T", parentId: "nope" }))).status).toBe(400);
    expect(invalidateGraphCache).not.toHaveBeenCalled();
  });
});

describe("GET /api/pages 응답", () => {
  it("라우트가 docType 을 select 하고 withTreeMeta 를 쓴다(본문은 lib/pagesList — U7)", () => {
    expect(readFileSync("app/api/pages/route.ts", "utf8")).toMatch(/listPagesForSidebar\(guard, undefined, \{ archived \}\)/);
    const src = readFileSync("lib/pagesList.ts", "utf8");
    expect(src).toMatch(/docType: true/);
    expect(src).toMatch(/withTreeMeta\(/);
  });
  it("withTreeMeta 는 childCount·isFavorite 을 붙인다", () => {
    const pages = [
      { id: "a", parentId: null, docType: null },
      { id: "b", parentId: "a", docType: "design" },
      { id: "c", parentId: "a", docType: "task_note" },
    ];
    const out = withTreeMeta(pages, new Set(["b"]));
    expect(out.find((p) => p.id === "a")).toMatchObject({ childCount: 2, isFavorite: false });
    expect(out.find((p) => p.id === "b")).toMatchObject({ childCount: 0, isFavorite: true });
  });
});

describe("POST /api/pages — folder·docType", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor" });
    m(visibleOnly).mockImplementation((_a: unknown, rows: unknown) => rows);
    m(loadAccess).mockResolvedValue({});
    m(resolveProjectRef).mockResolvedValue({ ok: true, projectId: null });
    m(prisma.page.findFirst).mockResolvedValue(null);
    m(prisma.page.findMany).mockResolvedValue([]);
    m(prisma.page.create).mockImplementation(async ({ data }: { data: { title: string; parentId: string | null } }) => ({
      id: `id-${data.title}`, title: data.title, parentId: data.parentId, kind: "doc",
    }));
  });

  it("folder 가 없으면 폴더 문서를 먼저 만들고 그 아래에 docType 과 함께 생성", async () => {
    expect((await POST(post({ title: "T", folder: "설계", docType: "design" }))).status).toBe(200);
    const calls = m(prisma.page.create).mock.calls.map((c) => c[0].data);
    expect(calls[0]).toMatchObject({ title: "설계", parentId: null });
    expect(calls[1]).toMatchObject({ title: "T", parentId: "id-설계", docType: "design" });
  });

  it("잘못된 docType 은 400", async () => {
    expect((await POST(post({ title: "T", docType: "nope" }))).status).toBe(400);
  });

  it("공백뿐인 folder 는 400", async () => {
    expect((await POST(post({ title: "T", folder: "   " }))).status).toBe(400);
    expect(prisma.page.create).not.toHaveBeenCalled();
  });

  it("같은 제목 폴더가 있으면 새로 만들지 않고 그 id 를 부모로 쓴다", async () => {
    m(prisma.page.findFirst).mockImplementation(async (a: { where: { title?: string } }) =>
      a.where.title === "설계" ? { id: "f1" } : null,
    );
    m(gatePage).mockReturnValue({});
    expect((await POST(post({ title: "T", folder: "설계" }))).status).toBe(200);
    const calls = m(prisma.page.create).mock.calls.map((c) => c[0].data);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ title: "T", parentId: "f1" });
  });

  it("찾은 폴더가 gatePage 에 막히면 그 응답을 돌려주고 문서를 만들지 않는다", async () => {
    m(prisma.page.findFirst).mockImplementation(async (a: { where: { title?: string } }) =>
      a.where.title === "설계" ? { id: "f1" } : null,
    );
    m(gatePage).mockReturnValue({ err: new Response(null, { status: 404 }) });
    expect((await POST(post({ title: "T", folder: "설계" }))).status).toBe(404);
    expect(prisma.page.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/pages — 템플릿 조합", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(prisma.page.count).mockResolvedValue(0); // 보관 페이지 없음 — findSameTitleDocs 의 보관 제외 빠른 경로
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor" });
    m(visibleOnly).mockImplementation((_a: unknown, rows: unknown) => rows);
    m(loadAccess).mockResolvedValue({});
    m(resolveProjectRef).mockResolvedValue({ ok: true, projectId: null });
    m(prisma.page.findFirst).mockResolvedValue(null);
    m(prisma.page.findMany).mockResolvedValue([]);
    m(prisma.page.create).mockResolvedValue({ id: "p1", title: "T", parentId: null, kind: "doc" });
  });

  it("template + folder → 폴더 아래에 템플릿 본문·docType 으로 생성", async () => {
    m(prisma.page.create)
      .mockResolvedValueOnce({ id: "f1", title: "계획", parentId: null, kind: "doc" })
      .mockResolvedValueOnce({ id: "p1", title: "T", parentId: "f1", kind: "doc" });
    expect((await POST(post({ title: "T", template: "plan", folder: "계획" }))).status).toBe(200);
    const last = m(prisma.page.create).mock.calls.at(-1)![0].data;
    expect(last.parentId).toBe("f1");
    expect(last.docType).toBe("plan");
    expect(last.markdown).toContain("> 템플릿: plan ·");
  });

  it("template + 같은 제목 → 경고만 붙고 템플릿 본문으로 생성", async () => {
    m(prisma.page.findMany).mockResolvedValue([{ id: "d1", title: "T" }]);
    const res = await POST(post({ title: "T", template: "report" }));
    expect(res.status).toBe(200);
    expect((await res.json()).warnings).toEqual([{ code: "duplicate_title", pages: [{ id: "d1", title: "T" }] }]);
    expect(m(prisma.page.create).mock.calls[0][0].data.markdown).toContain("> 템플릿: report ·");
  });

  it("template + ifUnique + 같은 제목 → 409, 생성 안 함", async () => {
    m(prisma.page.findMany).mockResolvedValue([{ id: "d1", title: "T" }]);
    expect((await POST(post({ title: "T", template: "report", ifUnique: true }))).status).toBe(409);
    expect(prisma.page.create).not.toHaveBeenCalled();
  });

  it("kind:database 는 template 을 무시한다(본문·docType 없음)", async () => {
    m(prisma.page.create).mockResolvedValue({ id: "p1", title: "T", parentId: null, kind: "database" });
    expect((await POST(post({ title: "T", kind: "database", template: "design" }))).status).toBe(200);
    const data = m(prisma.page.create).mock.calls[0][0].data;
    expect(data.kind).toBe("database");
    expect(data.markdown).toBe("# T\n");
    expect(data.markdown).not.toContain("템플릿");
    expect(data.docType).toBeUndefined();
  });
});

describe("POST /api/pages — 같은 제목 경고(B5)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(prisma.page.count).mockResolvedValue(0); // 보관 페이지 없음 — findSameTitleDocs 의 보관 제외 빠른 경로
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "editor" });
    m(visibleOnly).mockImplementation((_a: unknown, rows: unknown) => rows);
    m(loadAccess).mockResolvedValue({});
    m(resolveProjectRef).mockResolvedValue({ ok: true, projectId: "pr1" });
    m(projectAccess).mockReturnValue("edit");
    m(prisma.page.findFirst).mockResolvedValue(null);
    m(prisma.page.findMany).mockResolvedValue([{ id: "d1", title: "설계" }]);
    m(prisma.project.findUnique).mockResolvedValue({ docsDir: null, name: "P" });
    m(prisma.page.create).mockResolvedValue({ id: "p1", title: "설계", parentId: null, kind: "doc" });
  });

  it("기본: 만들고 warnings 를 붙인다", async () => {
    const res = await POST(post({ title: "설계", projectId: "pr1" }));
    expect(res.status).toBe(200);
    expect((await res.json()).warnings).toEqual([{ code: "duplicate_title", pages: [{ id: "d1", title: "설계" }] }]);
    expect(m(prisma.page.findMany).mock.calls[0][0].where).toMatchObject({ workspaceId: "w1", projectId: "pr1", kind: "doc" });
  });

  it("ifUnique: 409 + duplicates, 생성 안 함", async () => {
    const res = await POST(post({ title: "설계", projectId: "pr1", ifUnique: true }));
    expect(res.status).toBe(409);
    expect((await res.json()).duplicates).toEqual([{ id: "d1", title: "설계" }]);
    expect(prisma.page.create).not.toHaveBeenCalled();
  });

  it("중복이 없으면 응답에 warnings 키가 없다", async () => {
    m(prisma.page.findMany).mockResolvedValue([]);
    const body = await (await POST(post({ title: "설계", projectId: "pr1", ifUnique: true }))).json();
    expect(body).not.toHaveProperty("warnings");
  });

  it("database 는 제목 조회를 하지 않는다", async () => {
    m(prisma.page.create).mockResolvedValue({ id: "p1", title: "설계", parentId: null, kind: "database" });
    const res = await POST(post({ title: "설계", kind: "database", ifUnique: true }));
    expect(res.status).toBe(200);
    expect(prisma.page.findMany).not.toHaveBeenCalled();
  });

  it("가시성: 못 보는 후보는 숨기고 보이는 것만 응답한다", async () => {
    m(prisma.page.findMany).mockResolvedValue([{ id: "d1", title: "설계" }, { id: "d2", title: "설계" }]);
    m(visibleOnly).mockImplementation((_a: unknown, rows: { id: string }[]) => rows.filter((r) => r.id !== "d2"));
    const res = await POST(post({ title: "설계", projectId: "pr1" }));
    expect((await res.json()).warnings).toEqual([{ code: "duplicate_title", pages: [{ id: "d1", title: "설계" }] }]);
    const res409 = await POST(post({ title: "설계", projectId: "pr1", ifUnique: true }));
    expect((await res409.json()).duplicates).toEqual([{ id: "d1", title: "설계" }]);
  });

  it("가시성: 전부 숨겨지면 409 도 warnings 도 없다", async () => {
    m(visibleOnly).mockImplementation(() => []);
    const res = await POST(post({ title: "설계", projectId: "pr1", ifUnique: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty("warnings");
  });

  it("프로젝트 없음(null) 버킷에서도 같은 제목을 찾는다", async () => {
    m(resolveProjectRef).mockResolvedValue({ ok: true, projectId: null });
    const res = await POST(post({ title: "설계" }));
    expect(res.status).toBe(200);
    expect(m(prisma.page.findMany).mock.calls[0][0].where).toMatchObject({ workspaceId: "w1", projectId: null, kind: "doc" });
    expect((await res.json()).warnings).toEqual([{ code: "duplicate_title", pages: [{ id: "d1", title: "설계" }] }]);
  });
});
