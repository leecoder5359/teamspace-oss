/* =====================================================================
   레슨 주입 점검(순수) — 연결 점검·주입 통계·정리 후보.
   DB 조회는 라우트(app/api/lessons/inspect·injections)가 하고, 여기는 계산만 한다.
   설계: TeamSpace doc "레슨 주입 점검 화면 설계".
   ===================================================================== */

import { resolveRouteByCwd } from "@/lib/ingest";

/* ── 연결 점검 ───────────────────────────────────────────────────────── */

export type RuleLite = { id: string; cwdPrefix: string; projectId: string | null; priority: number; workspaceId: string };
export type ProjectLite = { id: string; name: string; stack: string[] };
export type LessonMeta = { id: string; title: string; projectId: string | null; stack: string | null };

export type LinkChecks = {
  /** ① 최근 주입 기록의 cwd 중 지금도 프로젝트로 해석되지 않는 것 */
  unmappedCwds: { cwd: string; count: number; lastAt: string }[];
  /** ② stack 이 비어 스택 레슨을 하나도 못 받는 프로젝트 */
  emptyStackProjects: { id: string; name: string; mapped: boolean; missedStackLessons: number }[];
  /** ③ 어느 프로젝트 stack 에도 안 맞는 스택 레슨(어디에도 주입되지 않음) */
  orphanStackLessons: { id: string; title: string; stack: string }[];
  /** ④ 없는 프로젝트를 가리키는 route-rule */
  brokenRouteRules: { id: string; cwdPrefix: string; projectId: string }[];
};

export function linkChecks(i: {
  rules: RuleLite[];
  projects: ProjectLite[];
  lessons: LessonMeta[];
  recentCwds: { cwd: string; count: number; lastAt: Date }[];
}): LinkChecks {
  const projectIds = new Set(i.projects.map((p) => p.id));
  // 해석은 /api/context 와 같은 함수로. 깨진 규칙이 이기면 그 cwd 도 '미매핑'이다(라우트가 project 를 null 로 떨군다).
  const unmappedCwds = i.recentCwds
    .filter((c) => {
      const pid = resolveRouteByCwd(c.cwd, i.rules)?.projectId ?? null;
      return !pid || !projectIds.has(pid);
    })
    .sort((a, b) => b.count - a.count || b.lastAt.getTime() - a.lastAt.getTime())
    .map((c) => ({ cwd: c.cwd, count: c.count, lastAt: c.lastAt.toISOString() }));

  const stackLessons = i.lessons.filter((l) => !l.projectId && l.stack);
  const mappedIds = new Set(i.rules.map((r) => r.projectId).filter((x): x is string => !!x));
  const emptyStackProjects = i.projects
    .filter((p) => p.stack.length === 0)
    .map((p) => ({ id: p.id, name: p.name, mapped: mappedIds.has(p.id), missedStackLessons: stackLessons.length }))
    .sort((a, b) => Number(b.mapped) - Number(a.mapped) || a.name.localeCompare(b.name, "ko"));

  const allStacks = new Set(i.projects.flatMap((p) => p.stack));
  const orphanStackLessons = stackLessons
    .filter((l) => !allStacks.has(l.stack as string))
    .map((l) => ({ id: l.id, title: l.title, stack: l.stack as string }));

  const brokenRouteRules = i.rules
    .filter((r) => r.projectId && !projectIds.has(r.projectId))
    .map((r) => ({ id: r.id, cwdPrefix: r.cwdPrefix, projectId: r.projectId as string }));

  return { unmappedCwds, emptyStackProjects, orphanStackLessons, brokenRouteRules };
}

/* ── 제목 유사도 ─────────────────────────────────────────────────────── */

/** 제목 토큰 — 공백·문장부호·기호로 자른다(한글은 어절 단위). 소문자, 중복 제거. */
export function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[\s\p{P}\p{S}]+/u)
      .filter(Boolean),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export const SIMILAR_TITLE_THRESHOLD = 0.6;

export function similarTitlePairs(
  lessons: { id: string; title: string }[],
  threshold = SIMILAR_TITLE_THRESHOLD,
): { a: { id: string; title: string }; b: { id: string; title: string }; score: number }[] {
  const toks = lessons.map((l) => titleTokens(l.title));
  const out: { a: { id: string; title: string }; b: { id: string; title: string }; score: number }[] = [];
  for (let x = 0; x < lessons.length; x++) {
    for (let y = x + 1; y < lessons.length; y++) {
      const s = jaccard(toks[x], toks[y]);
      if (s >= threshold) out.push({ a: { id: lessons[x].id, title: lessons[x].title }, b: { id: lessons[y].id, title: lessons[y].title }, score: Math.round(s * 100) / 100 });
    }
  }
  return out.sort((p, q) => q.score - p.score);
}

/* ── 주입 통계·정리 후보 ─────────────────────────────────────────────── */

export type InjectionRow = {
  id: string;
  createdAt: Date;
  actorName: string | null;
  cwd: string | null;
  projectId: string | null;
  via: string;
  mode: string;
  gistIds: string[];
  titleIds: string[];
  omittedIds: string[];
  chars: number;
};

export function injectionStats(i: {
  rows: InjectionRow[];
  reads: { lessonId: string }[];
  lessons: (LessonMeta & { createdAt: Date })[];
  projects: { id: string; name: string }[];
  days: number;
  now?: Date;
}) {
  const now = i.now ?? new Date();
  const since7 = now.getTime() - 7 * 86_400_000;
  const projName = new Map(i.projects.map((p) => [p.id, p.name]));

  // 프로젝트별 횟수(null = 프로젝트 미매핑 세션)
  const byProjectMap = new Map<string, { projectId: string | null; projectName: string | null; last7: number; lastN: number }>();
  for (const r of i.rows) {
    const k = r.projectId ?? "";
    const e = byProjectMap.get(k) ?? { projectId: r.projectId, projectName: r.projectId ? (projName.get(r.projectId) ?? null) : null, last7: 0, lastN: 0 };
    e.lastN++;
    if (r.createdAt.getTime() >= since7) e.last7++;
    byProjectMap.set(k, e);
  }
  const byProject = [...byProjectMap.values()].sort((a, b) => b.lastN - a.lastN);

  const cnt = (field: "gistIds" | "titleIds" | "omittedIds") => {
    const m = new Map<string, number>();
    for (const r of i.rows) for (const id of r[field]) m.set(id, (m.get(id) ?? 0) + 1);
    return m;
  };
  const g = cnt("gistIds");
  const t = cnt("titleIds");
  const o = cnt("omittedIds");
  const rd = new Map<string, number>();
  for (const r of i.reads) rd.set(r.lessonId, (rd.get(r.lessonId) ?? 0) + 1);

  const lessons = i.lessons.map((l) => ({
    id: l.id,
    title: l.title,
    scope: (l.projectId ? "project" : l.stack ? "stack" : "global") as "project" | "stack" | "global",
    projectId: l.projectId,
    stack: l.stack,
    gist: g.get(l.id) ?? 0,
    titleOnly: t.get(l.id) ?? 0,
    omitted: o.get(l.id) ?? 0,
    reads: rd.get(l.id) ?? 0,
  }));

  // 정리 후보 — 기록이 하나도 없으면 판단 근거가 없으므로 비운다(새로 깐 서버에서 전부 '0회' 로 뜨지 않게).
  // '늘 잘림' 은 compact(새 세션) 기록으로만 판단한다 — brief(이어가기)는 설계상 요약이 없고 전역을 개수로만 접는다.
  const compactRows = i.rows.filter((r) => r.mode !== "brief");
  const cg = new Set(compactRows.flatMap((r) => r.gistIds));
  const cSeen = new Set(compactRows.flatMap((r) => [...r.titleIds, ...r.omittedIds]));
  const alwaysTruncated = compactRows.length ? lessons.filter((l) => !cg.has(l.id) && cSeen.has(l.id)) : [];
  const neverInjected = i.rows.length ? lessons.filter((l) => l.gist + l.titleOnly + l.omitted === 0) : [];

  const recent = i.rows
    .slice()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 20)
    .map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      actorName: r.actorName,
      cwd: r.cwd,
      projectId: r.projectId,
      projectName: r.projectId ? (projName.get(r.projectId) ?? null) : null,
      via: r.via,
      mode: r.mode,
      gist: r.gistIds.length,
      titleOnly: r.titleIds.length,
      omitted: r.omittedIds.length,
      chars: r.chars,
    }));

  return {
    days: i.days,
    totals: { injections: i.rows.length, last7: i.rows.filter((r) => r.createdAt.getTime() >= since7).length, reads: i.reads.length },
    byProject,
    recent,
    lessons,
    cleanup: {
      alwaysTruncated: alwaysTruncated.map(({ id, title, titleOnly, omitted }) => ({ id, title, titleOnly, omitted })),
      neverInjected: neverInjected.map(({ id, title, scope, stack }) => ({ id, title, scope, stack })),
      similarTitles: similarTitlePairs(i.lessons),
    },
  };
}
