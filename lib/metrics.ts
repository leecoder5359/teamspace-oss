import { prisma } from "@/lib/prisma";
import { getTeamspaceUsage } from "@/lib/aiRoutes/llmCalls";
import { isOpenStatus } from "@/lib/taskFilter";
import { loadArchivedPageIds, excludeArchived } from "@/lib/pageArchive";

/**
 * 주간 지표 스냅샷(피드백 루프 ①) — 워커가 매주 1행 남기고, 비교는 CLI/API 가 한다.
 * llm·injection 은 최근 7일 합, 나머지(docs·tasks·graph·llmCacheRows)는 찍는 시점의 현재 값.
 * docs·docsBytes 는 "활성 문서" 기준 — 보관(조상 규칙) 페이지는 뺀다.
 */
export type MetricData = {
  docs: number;
  docsBytes: number;
  tasksOpen: number;
  tasksDone: number;
  graphNodes: number;
  graphEdges: number;
  /** usd 는 admin 에게만 나간다 — 편집자용 응답에는 키 자체가 없으므로 optional. null = 미상. */
  llm: { calls: number; cacheHits: number; inputTokens: number; outputTokens: number; usd?: number | null };
  injection: { count: number; chars: number };
  llmCacheRows: number;
};

const DAY_MS = 86_400_000;

/** ISO 8601 주 키 "2026-W41" — UTC 기준(서버 TZ 에 따라 키가 달라지지 않게). 월요일 시작, 목요일이 속한 해가 주의 해. */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7; // 월=1 … 일=7
  t.setUTCDate(t.getUTCDate() + 4 - dow); // 이번 주 목요일
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** 보드별 상태 속성 선택은 /api/tasks 와 같은 규칙: 이름이 status|상태 인 select, 없으면 첫 select. */
function pickStatusProp<T extends { name: string }>(selects: T[]): T | null {
  return selects.find((p) => /status|상태/i.test(p.name)) ?? selects[0] ?? null;
}

async function countTasks(workspaceId: string): Promise<{ open: number; done: number }> {
  const props = await prisma.dbProperty.findMany({
    where: { type: "select", database: { workspaceId, deletedAt: null } },
    orderBy: { position: "asc" },
    select: { id: true, name: true, databasePageId: true, config: true },
  });
  const byBoard = new Map<string, typeof props>();
  for (const p of props) byBoard.set(p.databasePageId, [...(byBoard.get(p.databasePageId) ?? []), p]);
  const statusByBoard = new Map<string, { id: string; names: Map<string, string> }>();
  for (const [board, list] of byBoard) {
    const sp = pickStatusProp(list);
    if (!sp) continue;
    const opts = ((sp.config as { options?: { id: string; name: string }[] } | null)?.options ?? []);
    statusByBoard.set(board, { id: sp.id, names: new Map(opts.map((o) => [o.id, o.name])) });
  }
  if (statusByBoard.size === 0) return { open: 0, done: 0 };
  const rows = await prisma.dbRow.findMany({
    where: { databasePageId: { in: [...statusByBoard.keys()] } },
    select: { databasePageId: true, props: true },
  });
  let open = 0;
  let done = 0;
  for (const r of rows) {
    const st = statusByBoard.get(r.databasePageId);
    if (!st) continue;
    const name = st.names.get(String((r.props as Record<string, unknown>)?.[st.id] ?? "")) ?? null;
    if (isOpenStatus(name)) open++;
    else done++;
  }
  return { open, done };
}

export async function collectMetrics(workspaceId: string, now: Date = new Date()): Promise<MetricData> {
  const since = new Date(now.getTime() - 7 * DAY_MS);
  // 보관 집합을 먼저 읽는다 — 행 count 의 where 가 이 집합에 달려 있다(주 1회라 await 하나는 싸다).
  const archived = await loadArchivedPageIds(prisma, workspaceId);
  const archivedIds = [...archived];
  const [allPages, tasks, docNodes, projects, decisions, lessons, risks, rowNodes, bodyRows, graphEdges, usage, inj, llmCacheRows] = await Promise.all([
    // GET /api/pages 와 같은 select(권한 거름 전 워크스페이스 전체)
    prisma.page.findMany({
      where: { workspaceId, deletedAt: null },
      orderBy: [{ parentId: "asc" }, { position: "asc" }],
      select: { id: true, title: true, icon: true, parentId: true, position: true, kind: true, projectId: true, updatedAt: true, visibility: true, docType: true },
    }),
    countTasks(workspaceId),
    // graphNodes = loadGraph(lib/graphLoad.ts loadRaw) 의 권한 거름 전 입력 노드 수와 같다. 유일한 잔여 차이:
    //   여기 보관 집합은 모든 페이지 종류로 만들고 loadRaw 는 doc+database 만 본다.
    //   활성 문서(조상 규칙 보관 제외, 보관 보드의 행 본문 문서 제외) + 프로젝트 + 결정 + 팀 레슨(userId null) + 리스크
    //   + 활성 보드(삭제·보관 아님)의 행 중 행 본문 문서(contentPageId)가 보관되지 않은 것.
    // 문서는 전체 count 에서 아래 archivedDocs·droppedBodyDocs 를 뺀다.
    prisma.page.count({ where: { workspaceId, kind: "doc", deletedAt: null } }),
    prisma.project.count({ where: { workspaceId } }),
    prisma.decision.count({ where: { workspaceId } }),
    prisma.lesson.count({ where: { workspaceId, userId: null } }),
    prisma.risk.count({ where: { workspaceId } }),
    archived.size === 0
      ? prisma.dbRow.count({ where: { database: { workspaceId, deletedAt: null } } })
      : prisma.dbRow.count({
          where: {
            database: { workspaceId, deletedAt: null },
            databasePageId: { notIn: archivedIds },
            OR: [{ contentPageId: null }, { contentPageId: { notIn: archivedIds } }],
          },
        }),
    // 보관 보드 행의 본문 문서 id(그래프는 이 문서도 노드에서 뺀다)
    archived.size === 0
      ? Promise.resolve([] as { contentPageId: string | null }[])
      : prisma.dbRow.findMany({
          where: { database: { workspaceId, deletedAt: null }, databasePageId: { in: archivedIds }, contentPageId: { not: null } },
          select: { contentPageId: true },
        }),
    prisma.graphEdge.count({ where: { workspaceId } }),
    getTeamspaceUsage(workspaceId, 7, { now, purge: false }),
    prisma.lessonInjection.aggregate({ where: { workspaceId, createdAt: { gte: since } }, _count: { _all: true }, _sum: { chars: true } }),
    prisma.llmCache.count(), // 캐시는 워크스페이스 키가 없는 머신 단위
  ]);
  const pages = excludeArchived(allPages, archived);
  const archivedDocs = allPages.filter((p) => p.kind === "doc" && archived.has(p.id)).length;
  // 이미 보관 집합에 든 문서는 위에서 뺐으므로 한 번만 센다.
  const bodyIds = new Set(bodyRows.map((r) => r.contentPageId).filter((id): id is string => !!id));
  const droppedBodyDocs = allPages.filter((p) => p.kind === "doc" && bodyIds.has(p.id) && !archived.has(p.id)).length;
  return {
    docs: pages.length,
    docsBytes: JSON.stringify(pages).length,
    tasksOpen: tasks.open,
    tasksDone: tasks.done,
    graphNodes: docNodes - archivedDocs - droppedBodyDocs + projects + decisions + lessons + risks + rowNodes,
    graphEdges,
    llm: {
      calls: usage.totals.calls,
      cacheHits: usage.totals.cacheHits,
      inputTokens: usage.totals.inputTokens,
      outputTokens: usage.totals.outputTokens,
      usd: usage.totals.usd,
    },
    injection: { count: inj._count._all, chars: inj._sum.chars ?? 0 },
    llmCacheRows,
  };
}

/** 이번 ISO 주 스냅샷이 없으면 만든다. 이미 있으면 그대로 두고 created:false(동시 실행도 unique 로 한 행). */
export async function snapshotWeek(workspaceId: string, now: Date = new Date()): Promise<{ created: boolean; weekKey: string }> {
  const weekKey = isoWeekKey(now);
  const exists = await prisma.metricSnapshot.findUnique({ where: { workspaceId_weekKey: { workspaceId, weekKey } }, select: { id: true } });
  if (exists) return { created: false, weekKey };
  const data = await collectMetrics(workspaceId, now);
  try {
    await prisma.metricSnapshot.create({ data: { workspaceId, weekKey, data } });
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") return { created: false, weekKey };
    throw e;
  }
  return { created: true, weekKey };
}

function flatten(m: MetricData): Record<string, number | null> {
  return {
    docs: m.docs,
    docsBytes: m.docsBytes,
    tasksOpen: m.tasksOpen,
    tasksDone: m.tasksDone,
    graphNodes: m.graphNodes,
    graphEdges: m.graphEdges,
    "llm.calls": m.llm.calls,
    "llm.cacheHits": m.llm.cacheHits,
    "llm.inputTokens": m.llm.inputTokens,
    "llm.outputTokens": m.llm.outputTokens,
    "llm.usd": m.llm.usd ?? null,
    "injection.count": m.injection.count,
    "injection.chars": m.injection.chars,
    llmCacheRows: m.llmCacheRows,
  };
}

/** 지난 스냅샷(없으면 null) 대비 이번 값. 값이 null(usd 미상)이면 그대로 null — 0 으로 바꾸면 "비용 0" 으로 읽힌다.
    prev·cur 중 하나라도 null 이면 delta 는 null. */
export function diffMetrics(prev: MetricData | null, cur: MetricData): { key: string; prev: number | null; cur: number | null; delta: number | null }[] {
  const p = prev ? flatten(prev) : null;
  return Object.entries(flatten(cur)).map(([key, c]) => {
    const pv = p ? (p[key] ?? null) : null;
    return { key, prev: pv, cur: c, delta: pv === null || c === null ? null : Math.round((c - pv) * 1e6) / 1e6 };
  });
}

export type MetricsView = {
  weeks: { weekKey: string; data: MetricData; createdAt: string }[];
  diff: ReturnType<typeof diffMetrics>;
};

/** 비용(usd)은 admin 만 본다(결정 cmv0cy8vj). 비관리자에겐 필드를 0/null 이 아니라 아예 뺀다 — null 은 "미상"으로 읽히기 때문. */
export function stripCost(view: MetricsView, isAdmin: boolean): MetricsView {
  if (isAdmin) return view;
  // 허용 목록 복사 — 새 필드가 생겨도 여기에 명시하기 전엔 비관리자에게 나가지 않는다.
  return {
    weeks: view.weeks.map((w) => {
      const d = w.data;
      const data: MetricData = {
        docs: d.docs,
        docsBytes: d.docsBytes,
        tasksOpen: d.tasksOpen,
        tasksDone: d.tasksDone,
        graphNodes: d.graphNodes,
        graphEdges: d.graphEdges,
        llm: { calls: d.llm.calls, cacheHits: d.llm.cacheHits, inputTokens: d.llm.inputTokens, outputTokens: d.llm.outputTokens },
        injection: { count: d.injection.count, chars: d.injection.chars },
        llmCacheRows: d.llmCacheRows,
      };
      return { weekKey: w.weekKey, createdAt: w.createdAt, data };
    }),
    diff: view.diff.filter((d) => d.key !== "llm.usd"),
  };
}
