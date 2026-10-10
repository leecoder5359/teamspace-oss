import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    page: { findMany: vi.fn(), count: vi.fn() },
    dbProperty: { findMany: vi.fn() },
    dbRow: { findMany: vi.fn(), count: vi.fn() },
    project: { count: vi.fn() },
    decision: { count: vi.fn() },
    lesson: { count: vi.fn() },
    risk: { count: vi.fn() },
    graphEdge: { count: vi.fn() },
    lessonInjection: { aggregate: vi.fn() },
    llmCache: { count: vi.fn() },
    metricSnapshot: { findUnique: vi.fn(), create: vi.fn() },
  },
}));
vi.mock("@/lib/aiRoutes/llmCalls", () => ({ getTeamspaceUsage: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { getTeamspaceUsage } from "@/lib/aiRoutes/llmCalls";
import { isoWeekKey, diffMetrics, stripCost, collectMetrics, snapshotWeek, type MetricData } from "./metrics";

const p = prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;

describe("isoWeekKey", () => {
  it("연말·연초 경계는 ISO 주 해를 따른다", () => {
    expect(isoWeekKey(new Date("2025-12-29T10:00:00Z"))).toBe("2026-W01"); // 월요일, 목요일이 2026
    expect(isoWeekKey(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53"); // 금요일, 2026 은 53주
    expect(isoWeekKey(new Date("2027-01-04T00:00:00Z"))).toBe("2027-W01");
    expect(isoWeekKey(new Date("2024-12-30T00:00:00Z"))).toBe("2025-W01");
    expect(isoWeekKey(new Date("2026-10-09T00:00:00Z"))).toBe("2026-W41");
  });
  it("일요일은 그 주의 마지막 날", () => {
    expect(isoWeekKey(new Date("2026-10-11T23:59:00Z"))).toBe("2026-W41");
    expect(isoWeekKey(new Date("2026-10-12T00:00:00Z"))).toBe("2026-W42");
  });
});

const base: MetricData = {
  docs: 10, docsBytes: 1000, tasksOpen: 5, tasksDone: 2, graphNodes: 30, graphEdges: 40,
  llm: { calls: 10, cacheHits: 3, inputTokens: 100, outputTokens: 50, usd: null },
  injection: { count: 4, chars: 8000 }, llmCacheRows: 7,
};

describe("diffMetrics", () => {
  it("지난주가 없으면 prev·delta 가 null", () => {
    const d = diffMetrics(null, base);
    expect(d.find((x) => x.key === "docs")).toEqual({ key: "docs", prev: null, cur: 10, delta: null });
    expect(d.map((x) => x.key)).toContain("llm.calls");
    expect(d.map((x) => x.key)).toContain("injection.chars");
  });
  it("평탄화 키로 증감을 계산하고 usd 미상은 delta null", () => {
    const cur: MetricData = { ...base, docs: 12, tasksOpen: 3, llm: { ...base.llm, calls: 15, usd: 0.5 } };
    const d = Object.fromEntries(diffMetrics(base, cur).map((x) => [x.key, x]));
    expect(d.docs).toEqual({ key: "docs", prev: 10, cur: 12, delta: 2 });
    expect(d.tasksOpen.delta).toBe(-2);
    expect(d["llm.calls"].delta).toBe(5);
    expect(d["llm.usd"]).toEqual({ key: "llm.usd", prev: null, cur: 0.5, delta: null });
  });
  it("이번 주 usd 미상은 0 이 아니라 null(CLI 는 —)", () => {
    const prev: MetricData = { ...base, llm: { ...base.llm, usd: 0.3 } };
    const d = Object.fromEntries(diffMetrics(prev, base).map((x) => [x.key, x]));
    expect(d["llm.usd"]).toEqual({ key: "llm.usd", prev: 0.3, cur: null, delta: null });
  });
});

describe("collectMetrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const pages = [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }];
    p.page.findMany.mockResolvedValue(pages);
    p.page.count.mockResolvedValue(2);
    p.project.count.mockResolvedValue(1);
    p.decision.count.mockResolvedValue(3);
    p.lesson.count.mockResolvedValue(4);
    p.risk.count.mockResolvedValue(5);
    p.dbRow.count.mockResolvedValue(6);
    p.graphEdge.count.mockResolvedValue(9);
    p.llmCache.count.mockResolvedValue(11);
    p.lessonInjection.aggregate.mockResolvedValue({ _count: { _all: 8 }, _sum: { chars: 20000 } });
    // 보드1: 상태 select(완료/진행), 보드2: 상태 없는 select 만 있는 보드 → 첫 select 사용, 보드3: select 없음(속성 자체가 안 나옴)
    p.dbProperty.findMany.mockResolvedValue([
      { id: "s1", name: "상태", databasePageId: "b1", config: { options: [{ id: "o1", name: "진행" }, { id: "o2", name: "완료" }] } },
      { id: "x1", name: "우선순위", databasePageId: "b1", config: { options: [{ id: "h", name: "높음" }] } },
      { id: "t2", name: "분류", databasePageId: "b2", config: { options: [{ id: "q1", name: "Done" }, { id: "q2", name: "할일" }] } },
    ]);
    p.dbRow.findMany.mockResolvedValue([
      { databasePageId: "b1", props: { s1: "o1" } },
      { databasePageId: "b1", props: { s1: "o2" } },
      { databasePageId: "b1", props: {} }, // 상태 미지정 = 열림
      { databasePageId: "b2", props: { t2: "q1" } },
      { databasePageId: "b2", props: { t2: "q2" } },
    ]);
    vi.mocked(getTeamspaceUsage).mockResolvedValue({
      totals: { calls: 12, cacheHits: 4, inputTokens: 1000, outputTokens: 300, usd: 0.25 },
    } as never);
  });

  it("각 지표를 합산한다", async () => {
    const now = new Date("2026-10-09T00:00:00Z");
    const m = await collectMetrics("w1", now);
    expect(m.docs).toBe(3);
    expect(m.docsBytes).toBe(JSON.stringify([{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }]).length);
    expect(m.tasksOpen).toBe(3); // 진행 + 미지정 + 할일
    expect(m.tasksDone).toBe(2); // 완료 + Done
    expect(m.graphNodes).toBe(2 + 1 + 3 + 4 + 5 + 6);
    expect(m.graphEdges).toBe(9);
    expect(m.llm).toEqual({ calls: 12, cacheHits: 4, inputTokens: 1000, outputTokens: 300, usd: 0.25 });
    expect(m.injection).toEqual({ count: 8, chars: 20000 });
    expect(m.llmCacheRows).toBe(11);
    expect(getTeamspaceUsage).toHaveBeenCalledWith("w1", 7, { now, purge: false });
    const where = p.lessonInjection.aggregate.mock.calls[0][0].where;
    expect(where.createdAt.gte).toEqual(new Date("2026-10-02T00:00:00Z"));
  });

  it("보관 문서(조상 규칙)는 docs·docsBytes 에서 빠진다", async () => {
    const at = new Date("2026-10-01T00:00:00Z");
    const rows = [{ id: "f", title: "F" }, { id: "c", title: "C" }, { id: "a", title: "A" }];
    p.page.count.mockImplementation(async (args: { where: { archivedAt?: unknown } }) => (args.where.archivedAt ? 1 : 2));
    p.page.findMany.mockImplementation(async (args: { select: Record<string, boolean> }) =>
      args.select.title
        ? rows
        : [{ id: "f", parentId: null, archivedAt: at }, { id: "c", parentId: "f", archivedAt: null }, { id: "a", parentId: null, archivedAt: null }],
    );
    const m = await collectMetrics("w1", new Date("2026-10-09T00:00:00Z"));
    expect(m.docs).toBe(1);
    expect(m.docsBytes).toBe(JSON.stringify([{ id: "a", title: "A" }]).length);
  });
});

describe("collectMetrics — graphNodes", () => {
  it("보관 문서(조상 규칙)는 그래프 노드 수에서 빠진다", async () => {
    vi.clearAllMocks();
    const at = new Date("2026-10-01T00:00:00Z");
    p.page.count.mockImplementation(async (args: { where: { archivedAt?: unknown } }) => (args.where.archivedAt ? 1 : 3));
    p.page.findMany.mockImplementation(async (args: { select: Record<string, boolean> }) =>
      args.select.title
        ? [{ id: "f", kind: "doc" }, { id: "c", kind: "doc" }, { id: "a", kind: "doc" }]
        : [{ id: "f", parentId: null, archivedAt: at }, { id: "c", parentId: "f", archivedAt: null }, { id: "a", parentId: null, archivedAt: null }],
    );
    for (const k of ["project", "decision", "lesson", "risk", "graphEdge", "llmCache"]) p[k].count.mockResolvedValue(0);
    p.dbRow.count.mockResolvedValue(0);
    p.dbRow.findMany.mockResolvedValue([]);
    p.dbProperty.findMany.mockResolvedValue([]);
    p.lessonInjection.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { chars: null } });
    vi.mocked(getTeamspaceUsage).mockResolvedValue({ totals: { calls: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, usd: null } } as never);
    const m = await collectMetrics("w1", new Date("2026-10-09T00:00:00Z"));
    expect(m.graphNodes).toBe(1); // 문서 3 − 보관(폴더 + 그 자식) 2
  });
});

describe("snapshotWeek", () => {
  beforeEach(() => vi.clearAllMocks());
  it("이번 주 행이 있으면 만들지 않는다", async () => {
    p.metricSnapshot.findUnique.mockResolvedValue({ id: "x" });
    expect(await snapshotWeek("w1", new Date("2026-10-09T00:00:00Z"))).toEqual({ created: false, weekKey: "2026-W41" });
    expect(p.metricSnapshot.create).not.toHaveBeenCalled();
  });
  it("unique 충돌(P2002)은 created:false", async () => {
    p.metricSnapshot.findUnique.mockResolvedValue(null);
    p.page.findMany.mockResolvedValue([]);
    for (const k of ["page", "dbRow", "project", "decision", "lesson", "risk", "graphEdge", "llmCache"]) if (p[k].count) p[k].count.mockResolvedValue(0);
    p.dbProperty.findMany.mockResolvedValue([]);
    p.lessonInjection.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { chars: null } });
    vi.mocked(getTeamspaceUsage).mockResolvedValue({ totals: { calls: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, usd: null } } as never);
    p.metricSnapshot.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    expect((await snapshotWeek("w1", new Date("2026-10-09T00:00:00Z"))).created).toBe(false);
  });
});

describe("stripCost", () => {
  const md = (usd: number | null): MetricData => ({ docs: 1, docsBytes: 1, tasksOpen: 0, tasksDone: 0, graphNodes: 0, graphEdges: 0, llm: { calls: 1, cacheHits: 0, inputTokens: 1, outputTokens: 1, usd }, injection: { count: 0, chars: 0 }, llmCacheRows: 0 });
  const view = () => ({ weeks: [{ weekKey: "2026-W41", data: md(1.5), createdAt: "x" }], diff: diffMetrics(md(1), md(1.5)) });
  it("비관리자: usd 필드·diff 행 제거(null/0 이 아니라 생략), 나머지 llm 값은 유지", () => {
    const o = stripCost(view(), false);
    expect(JSON.stringify(o)).not.toMatch(/usd/i);
    expect(o.weeks[0].data.llm).toEqual({ calls: 1, cacheHits: 0, inputTokens: 1, outputTokens: 1 });
  });
  it("관리자: 그대로", () => {
    const v = view();
    expect(stripCost(v, true)).toBe(v);
  });
  it("허용 목록 복사 — 모르는 필드는 비관리자에게 새지 않는다", () => {
    const v = view();
    (v.weeks[0].data as unknown as Record<string, unknown>).secretNew = "x";
    (v.weeks[0].data.llm as unknown as Record<string, unknown>).secretLlm = "y";
    expect(JSON.stringify(stripCost(v, false))).not.toMatch(/secret/);
  });
  it("원본을 변형하지 않는다", () => {
    const v = view();
    stripCost(v, false);
    expect(v.weeks[0].data.llm.usd).toBe(1.5);
  });
});

describe("collectMetrics — graphNodes 는 loadGraph 입력과 일치", () => {
  type Row = { databasePageId: string; contentPageId: string | null };
  function setup(rows: Row[], pages: { id: string; parentId: string | null; archivedAt: Date | null; kind: string }[]) {
    vi.clearAllMocks();
    p.page.count.mockImplementation(async (args: { where: { archivedAt?: unknown; kind?: string } }) =>
      args.where.archivedAt ? pages.filter((x) => x.archivedAt).length : pages.filter((x) => x.kind === "doc").length,
    );
    p.page.findMany.mockResolvedValue(pages);
    for (const k of ["project", "decision", "risk", "graphEdge", "llmCache"]) p[k].count.mockResolvedValue(0);
    p.lesson.count.mockImplementation(async (args: { where: { userId?: null } }) => (args.where.userId === null ? 1 : 2)); // 팀 1 + 개인 1
    // where 를 실제로 평가하는 가짜 — notIn/in/OR/null 만 다룬다.
    const match = (r: Row, where: Record<string, unknown>) => {
      const dp = where.databasePageId as { notIn?: string[]; in?: string[] } | undefined;
      if (dp?.notIn && dp.notIn.includes(r.databasePageId)) return false;
      if (dp?.in && !dp.in.includes(r.databasePageId)) return false;
      const or = where.OR as { contentPageId: null | { notIn: string[] } }[] | undefined;
      if (or && !or.some((c) => (c.contentPageId === null ? r.contentPageId === null : r.contentPageId === null || !c.contentPageId.notIn.includes(r.contentPageId)))) return false;
      const cp = where.contentPageId as { not?: null } | undefined;
      if (cp && "not" in cp && r.contentPageId === null) return false;
      return true;
    };
    p.dbRow.count.mockImplementation(async (args: { where: Record<string, unknown> }) => rows.filter((r) => match(r, args.where)).length);
    p.dbRow.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) =>
      rows.filter((r) => match(r, args.where)).map((r) => ({ contentPageId: r.contentPageId, databasePageId: r.databasePageId, props: {} })),
    );
    p.dbProperty.findMany.mockResolvedValue([]);
    p.lessonInjection.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { chars: null } });
    vi.mocked(getTeamspaceUsage).mockResolvedValue({ totals: { calls: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, usd: null } } as never);
  }
  const at = new Date("2026-10-01T00:00:00Z");
  const now = new Date("2026-10-09T00:00:00Z");

  it("보관 보드의 행 2개·행 본문 문서·개인 레슨은 노드에서 빠진다", async () => {
    setup(
      [
        { databasePageId: "archBoard", contentPageId: null },
        { databasePageId: "archBoard", contentPageId: "body1" },
        { databasePageId: "liveBoard", contentPageId: null },
      ],
      [
        { id: "archBoard", parentId: null, archivedAt: at, kind: "database" },
        { id: "liveBoard", parentId: null, archivedAt: null, kind: "database" },
        { id: "body1", parentId: null, archivedAt: null, kind: "doc" }, // 보드와 부모 관계는 없지만 행 본문이라 뺀다
        { id: "doc1", parentId: null, archivedAt: null, kind: "doc" },
      ],
    );
    const m = await collectMetrics("w1", now);
    // 문서 doc1 만 + 팀 레슨 1 + 활성 보드 행 1
    expect(m.graphNodes).toBe(1 + 1 + 1);
    expect(p.lesson.count).toHaveBeenCalledWith({ where: { workspaceId: "w1", userId: null } });
  });

  it("보관된 행 본문 문서를 가진 활성 보드의 행도 뺀다", async () => {
    setup(
      [
        { databasePageId: "liveBoard", contentPageId: "archBody" },
        { databasePageId: "liveBoard", contentPageId: "okBody" },
      ],
      [
        { id: "liveBoard", parentId: null, archivedAt: null, kind: "database" },
        { id: "archBody", parentId: null, archivedAt: at, kind: "doc" },
        { id: "okBody", parentId: null, archivedAt: null, kind: "doc" },
      ],
    );
    const m = await collectMetrics("w1", now);
    expect(m.graphNodes).toBe(1 /* okBody */ + 1 /* 팀 레슨 */ + 1 /* okBody 행 */);
  });

  it("보관이 없으면 행은 단일 count(notIn 없음)", async () => {
    setup([{ databasePageId: "b", contentPageId: null }], [{ id: "d", parentId: null, archivedAt: null, kind: "doc" }]);
    const m = await collectMetrics("w1", now);
    expect(m.graphNodes).toBe(1 + 1 + 1);
    expect(p.dbRow.count).toHaveBeenCalledTimes(1);
    expect(p.dbRow.count.mock.calls[0][0]).toEqual({ where: { database: { workspaceId: "w1", deletedAt: null } } });
    expect(p.dbRow.findMany).not.toHaveBeenCalledWith(expect.objectContaining({ select: { contentPageId: true } }));
  });
});
