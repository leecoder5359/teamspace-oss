import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/pageGuard", () => ({ loadAccess: vi.fn(async () => ({})), pageAccess: () => "view", projectAccess: () => "edit", visibleOnly: (_i: unknown, r: unknown[]) => r }));
vi.mock("@/lib/graphLoad", () => ({ loadGraph: vi.fn() }));
vi.mock("@/lib/prisma", () => {
  const fm = () => ({ findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null), count: vi.fn(async () => 0) });
  return { prisma: { workspaceRouteRule: fm(), project: fm(), workspace: fm(), page: fm(), dbProperty: fm(), dbRow: fm(), decision: fm(), risk: fm(), glossaryTerm: fm(), lesson: fm() } };
});

import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { loadGraph } from "@/lib/graphLoad";
import { GET } from "./route";

const m = (f: unknown) => f as Mock;
const d = (id: string, projectId: string | null = null) => ({ id, title: `문서-${id}`, type: "doc", href: `/p/${id}`, projectId });
const E = (from: string, to: string) => ({ from, to, kind: "link", kinds: ["link"], tag: "추출" });

describe("GET /api/context — 지식 지도", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "member" });
    m(loadGraph).mockResolvedValue({ nodes: [d("a"), d("b"), d("c")], edges: [E("a", "b"), E("a", "c")] });
  });

  it("compact 에 허브가 들어간다", async () => {
    const md = await (await GET(new Request("http://t/api/context?compact=1"))).text();
    expect(md).toContain("## 지식 지도");
    expect(md).toContain("- 문서-a (연결 2) `a`");
  });

  it("그래프 로드가 실패해도 컨텍스트는 나간다(섹션만 생략)", async () => {
    m(loadGraph).mockRejectedValue(new Error("boom"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(new Request("http://t/api/context?compact=1"));
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("## 지식 지도");
    // 구조화 로그(lib/log)로 남는다 — warn 은 stderr(console.error) 싱크
    expect(String(err.mock.calls[0]?.[0])).toContain("context.knowledge_map_skipped");
    err.mockRestore();
  });

  it("그래프 로드가 멈춰도(800ms 타임아웃) 컨텍스트는 나간다", async () => {
    vi.useFakeTimers();
    try {
      m(loadGraph).mockReturnValue(new Promise(() => {}));
      const p = GET(new Request("http://t/api/context?compact=1"));
      await vi.advanceTimersByTimeAsync(900);
      const res = await p;
      expect(res.status).toBe(200);
      const md = await res.text();
      expect(md).not.toContain("## 지식 지도");
      expect(md).toContain("# 워크스페이스");
    } finally {
      vi.useRealTimers();
    }
  });

  it("compact 지도는 ~1200자 안으로 자르되 제목 줄은 유지한다", async () => {
    const nodes = Array.from({ length: 80 }, (_, i) => d(`n${i}`));
    const edges = nodes.slice(1).map((n) => E("n0", n.id));
    m(loadGraph).mockResolvedValue({ nodes, edges });
    const md = await (await GET(new Request("http://t/api/context?compact=1"))).text();
    const start = md.indexOf("## 지식 지도");
    expect(start).toBeGreaterThan(-1);
    const end = md.indexOf("\n## ", start + 5);
    expect(md.slice(start, end === -1 ? undefined : end).length).toBeLessThanOrEqual(1300);
  });
});

describe("GET /api/context — brief(resume/compact 훅)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "member", actor: { type: "user", id: "u1", name: "이준" } });
    m(loadGraph).mockResolvedValue({ nodes: [d("a"), d("b")], edges: [E("a", "b")] });
  });

  it("brief=1 은 짧은 요약 + MCP context_get 안내, 지식 지도는 그리지 않는다", async () => {
    const res = await GET(new Request("http://t/api/context?brief=1"));
    expect(res.status).toBe(200);
    const md = await res.text();
    expect(md).toContain("MCP context_get");
    expect(md).not.toContain("## 지식 지도");
    expect(Buffer.byteLength(md, "utf8")).toBeLessThan(3000);
    expect(loadGraph).not.toHaveBeenCalled();
  });

  it("compact=1 과 같이 오면 brief 가 우선", async () => {
    const md = await (await GET(new Request("http://t/api/context?compact=1&brief=1"))).text();
    expect(md).toContain("MCP context_get");
    expect(md).not.toContain("## 지식 지도");
  });

  it("format=json 은 brief 여도 { markdown, counts } 형태 그대로", async () => {
    const body = await (await GET(new Request("http://t/api/context?brief=1&format=json"))).json();
    expect(Object.keys(body).sort()).toEqual(["counts", "markdown"]);
    expect(body.markdown).toContain("MCP context_get");
  });
});

// 빈 mock DB 만으로는 brief 가 실제 규모(레슨 수십·태스크 수백)에서 예산 안에 드는지, 렌더러에 올바른 입력이
// 흘러가는지 알 수 없다 — 현실적 규모의 행을 prisma mock 에 실어 라우트 전체를 통과시킨다.
// 개수 줄은 count() 로 센다 — 목록 mock 과 같은 값을 count mock 에도 싣는다.
// take 상한을 넘는 개수는 route.counts.test.ts 가 본다.
describe("GET /api/context — brief 현실적 fixture", () => {
  const pm = (f: unknown) => f as Mock;
  const opts = [{ id: "o1", name: "시작 전" }, { id: "o2", name: "진행 중" }, { id: "o3", name: "완료" }];

  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "member", actor: { type: "user", id: "u1", name: "이준" } });
    pm(prisma.workspaceRouteRule.findMany).mockResolvedValue([{ cwdPrefix: "/work/banjang", workspaceId: "w1", projectId: "p1", priority: 0 }]);
    pm(prisma.project.findUnique).mockResolvedValue({ name: "반장", stack: ["next"] });
    pm(prisma.workspace.findUnique).mockResolvedValue({ name: "팀 워크스페이스" });
    pm(prisma.page.findMany).mockImplementation(async (a: { where: { kind: string } }) =>
      a.where.kind === "database"
        ? [{ id: "db1" }]
        : Array.from({ length: 47 }, (_, i) => ({ id: `d${i}`, title: `문서 ${i}`, updatedAt: new Date() })),
    );
    pm(prisma.dbProperty.findMany).mockResolvedValue([
      { id: "t", name: "이름", type: "text", config: {}, position: 0 },
      { id: "s", name: "상태", type: "select", config: { options: opts }, position: 1 },
      { id: "a", name: "담당", type: "text", config: {}, position: 2 },
      { id: "u", name: "마감", type: "date", config: {}, position: 3 },
    ]);
    // 열린 150 + 완료 20(제외돼야 함)
    pm(prisma.dbRow.findMany).mockResolvedValue([
      ...Array.from({ length: 150 }, (_, i) => ({ props: { t: `열린 태스크 ${i}`, s: i % 3 === 0 ? "o2" : "o1", a: i % 7 === 0 ? "이준" : "남", u: null } })),
      ...Array.from({ length: 20 }, (_, i) => ({ props: { t: `끝난 태스크 ${i}`, s: "o3", a: "이준", u: null } })),
    ]);
    pm(prisma.decision.findMany).mockResolvedValue(Array.from({ length: 19 }, (_, i) => ({ title: `결정 ${i}`, decision: "x" })));
    pm(prisma.risk.findMany).mockResolvedValue([]);
    pm(prisma.glossaryTerm.findMany).mockResolvedValue(Array.from({ length: 12 }, (_, i) => ({ term: `용어${i}`, definition: "d" })));
    pm(prisma.lesson.findMany).mockResolvedValue([
      ...Array.from({ length: 25 }, (_, i) => ({ id: `cmproj${String(i).padStart(19, "0")}`, title: `프로젝트 레슨 ${i}`, body: "처방 ".repeat(80), projectId: "p1", stack: null })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: `cmstck${String(i).padStart(19, "0")}`, title: `스택 레슨 ${i}`, body: "b", projectId: null, stack: "next" })),
      ...Array.from({ length: 25 }, (_, i) => ({ id: `cmglob${String(i).padStart(19, "0")}`, title: `전역 레슨 ${i}`, body: "b", projectId: null, stack: null })),
    ]);
    (prisma as unknown as { envTarget: { findMany: Mock } }).envTarget = { findMany: vi.fn(async () => []) };
    pm(prisma.page.count).mockImplementation(async (a: { where: { kind?: string } }) => (a.where.kind === "doc" ? 47 : 0));
    pm(prisma.decision.count).mockResolvedValue(19);
    pm(prisma.risk.count).mockResolvedValue(0);
    pm(prisma.glossaryTerm.count).mockResolvedValue(12);
    pm(prisma.lesson.count).mockResolvedValue(60);
  });

  it("레슨 60·열린 태스크 150·문서 47 에서도 brief 는 3000B 미만, 개수 줄이 실제 행 수와 맞는다", async () => {
    const res = await GET(new Request("http://t/api/context?brief=1&cwd=/work/banjang/app"));
    expect(res.status).toBe(200);
    const md = await res.text();
    expect(Buffer.byteLength(md, "utf8")).toBeLessThan(3000);
    expect(md.split("\n")[0]).toBe("# 워크스페이스: 팀 워크스페이스 · 프로젝트: 반장");
    expect(md).toContain("## 열린 태스크 150건"); // 완료 20건 제외
    expect(md).not.toContain("끝난 태스크");
    expect(md).toContain("문서 47 · 결정 19 · 리스크 0 · 용어 12");
    expect(md).toContain("전역 25건");
    expect(md).toContain("`cmproj0000000000000000000`");
    expect(md).not.toContain("처방"); // 레슨 본문은 brief 에 없다
  });

  it("format=json counts 는 전체 행 수를 담는다", async () => {
    const body = await (await GET(new Request("http://t/api/context?brief=1&format=json&cwd=/work/banjang"))).json();
    expect(body.counts).toMatchObject({ lessons: 60, tasks: 150, docs: 47, decisions: 19, risks: 0, glossary: 12 });
  });
});

describe("GET /api/context — 보관(F2 문서·F10 프로젝트)은 주입하지 않는다", () => {
  type Where = Record<string, unknown>;
  const p = () => (prisma as unknown as Record<string, { findMany: Mock; findUnique: Mock; count: Mock }>);
  // 아주 작은 where 해석기 — 라우트가 만드는 모양(id.notIn · AND[OR[projectId null | notIn]] · kind · projectId)만.
  const match = (row: Record<string, unknown>, w: Where): boolean =>
    Object.entries(w).every(([k, v]) => {
      if (k === "AND") return (v as Where[]).every((x) => match(row, x));
      if (k === "OR") return (v as Where[]).some((x) => match(row, x));
      if (v && typeof v === "object" && "notIn" in (v as object)) return !(v as { notIn: unknown[] }).notIn.includes(row[k]);
      if (v && typeof v === "object") return true; // deletedAt·docType 등 이 테스트와 무관한 조건
      if (k === "workspaceId" || k === "deletedAt" || k === "status") return true;
      return row[k] === v;
    });
  const pages = [
    { id: "live", title: "살아있는 문서", kind: "doc", projectId: null, parentId: null, archivedAt: null },
    { id: "arch", title: "보관 문서", kind: "doc", projectId: null, parentId: null, archivedAt: new Date(0) },
    { id: "child", title: "보관 부모의 자식", kind: "doc", projectId: null, parentId: "arch", archivedAt: null },
    { id: "inOld", title: "보관 프로젝트 문서", kind: "doc", projectId: "old", parentId: null, archivedAt: null },
  ];

  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "member" });
    m(loadGraph).mockResolvedValue({ nodes: pages.map((x) => d(x.id, x.projectId)), edges: [E("live", "arch"), E("live", "child"), E("live", "inOld")] });
    p().project.findMany.mockResolvedValue([{ id: "old" }]);
    p().page.count.mockResolvedValue(1);
    p().page.findMany.mockImplementation(async (a: { where: Where }) => pages.filter((x) => match(x, a.where)));
    p().decision.findMany.mockImplementation(async (a: { where: Where }) =>
      [{ title: "전역 결정", decision: null, projectId: null }, { title: "보관 프로젝트 결정", decision: null, projectId: "old" }].filter((x) => match(x, a.where)),
    );
  });

  it("보관 문서·그 하위·보관 프로젝트 문서와 결정은 목록·지식 지도에서 빠진다", async () => {
    const md = await (await GET(new Request("http://t/api/context"))).text();
    expect(md).toContain("- 살아있는 문서");
    expect(md).toContain("전역 결정");
    for (const gone of ["보관 문서", "보관 부모의 자식", "보관 프로젝트 문서", "보관 프로젝트 결정", "문서-arch", "문서-child", "문서-inOld"]) {
      expect(md).not.toContain(gone);
    }
  });

  it("cwd 가 보관 프로젝트로 매핑되면 매핑 없음(전역)으로 본다", async () => {
    p().workspaceRouteRule.findMany.mockResolvedValue([{ cwdPrefix: "/repo/old", workspaceId: "w1", projectId: "old", priority: 0 }]);
    p().project.findUnique.mockResolvedValue({ name: "옛 프로젝트", stack: [] });
    const md = await (await GET(new Request("http://t/api/context?cwd=/repo/old"))).text();
    expect(md).not.toContain("옛 프로젝트");
    expect(p().project.findUnique).not.toHaveBeenCalled();
  });

  it("보관이 하나도 없으면 트리를 읽지 않는다(count 한 번)", async () => {
    p().project.findMany.mockResolvedValue([]);
    p().page.count.mockResolvedValue(0);
    await GET(new Request("http://t/api/context"));
    const treeReads = p().page.findMany.mock.calls.filter(([a]) => !(a as { where: Where }).where.kind);
    expect(treeReads).toHaveLength(0);
  });
});
