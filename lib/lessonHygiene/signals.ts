/* =====================================================================
   레슨 주간 정리 — 결정적 신호(순수). DB 조회는 service.ts, 여기는 계산만.

   ① stale       : 최근 N일 동안 주입(요약·제목)도 조회도 0회인 레슨. 단 그 레슨이 들어갈 수 있는
                   세션이 창 안에 한 번도 없었다면(프로젝트 레슨인데 그 프로젝트 세션 0회 등) 제외 —
                   안 쓰인 게 아니라 쓸 기회가 없었다. 창 안에 새로 만든 레슨·required 도 제외.
   ② ondemandNoKeywords : mode=ondemand 인데 keywords 가 비어 메시지 매칭으로도 영영 안 들어가는 레슨.
   ③ similarPairs : 정규화 토큰 자카드 ≥ 0.6 인 제목 쌍(lib/lessonInspect/analyze 와 같은 함수).
   ④ requiredOver : required 가 15개 초과 — 세션 시작 예산을 필수가 다 먹는다.

   개인 레슨(userId)은 전부 제외한다 — 워커는 '누구의' 세션도 아니므로 남의 개인 레슨을 건드리지 않는다.
   ===================================================================== */

import { similarTitlePairs, SIMILAR_TITLE_THRESHOLD } from "@/lib/lessonInspect/analyze";
import { lessonModeOf, lessonScopeOf, type LessonMode, type LessonScope } from "@/lib/lessonInject";

export const STALE_DAYS = 30;
export const REQUIRED_MAX = 15;

export type HygieneLesson = {
  id: string;
  title: string;
  body: string;
  projectId: string | null;
  stack: string | null;
  userId: string | null;
  mode: string | null;
  keywords: string[];
  createdAt: Date;
};

export type InjectionLite = { projectId: string | null; gistIds: string[]; titleIds: string[] };

export type LessonRef = { id: string; title: string; scope: LessonScope; mode: LessonMode; projectId: string | null; stack: string | null };

export type HygieneSignals = {
  days: number;
  stale: LessonRef[];
  ondemandNoKeywords: LessonRef[];
  similarPairs: { a: LessonRef; b: LessonRef; score: number }[];
  requiredOver: { count: number; max: number; ids: string[] } | null;
};

const ref = (l: HygieneLesson): LessonRef => ({
  id: l.id,
  title: l.title,
  scope: lessonScopeOf(l),
  mode: lessonModeOf(l),
  projectId: l.projectId,
  stack: l.stack,
});

/** 개인 레슨 제외 — 정리 대상은 팀 레슨(전역·프로젝트·스택)뿐. */
export function teamLessons<T extends { userId: string | null }>(lessons: T[]): T[] {
  return lessons.filter((l) => !l.userId);
}

export function computeSignals(i: {
  lessons: HygieneLesson[];
  injections: InjectionLite[];
  reads: { lessonId: string }[];
  /** 창 안에 세션이 있었던 프로젝트의 stack(스택 레슨 판정용) */
  projects: { id: string; stack: string[] }[];
  days?: number;
  now?: Date;
  requiredMax?: number;
}): HygieneSignals {
  const days = i.days ?? STALE_DAYS;
  const now = i.now ?? new Date();
  const since = now.getTime() - days * 86_400_000;
  const max = i.requiredMax ?? REQUIRED_MAX;
  const lessons = teamLessons(i.lessons);

  const used = new Set<string>();
  for (const r of i.injections) for (const id of [...r.gistIds, ...r.titleIds]) used.add(id);
  for (const r of i.reads) used.add(r.lessonId);

  const activeProjects = new Set(i.injections.map((r) => r.projectId).filter((x): x is string => !!x));
  const anySession = i.injections.length > 0;
  const activeStacks = new Set(i.projects.filter((p) => activeProjects.has(p.id)).flatMap((p) => p.stack));
  const hadChance = (l: HygieneLesson): boolean => {
    if (l.projectId) return activeProjects.has(l.projectId);
    if (l.stack) return activeStacks.has(l.stack);
    return anySession;
  };

  const stale = lessons
    .filter((l) => lessonModeOf(l) !== "required" && l.createdAt.getTime() < since && !used.has(l.id) && hadChance(l))
    .map(ref);

  const ondemandNoKeywords = lessons.filter((l) => lessonModeOf(l) === "ondemand" && l.keywords.length === 0).map(ref);

  const byId = new Map(lessons.map((l) => [l.id, l]));
  const similarPairs = similarTitlePairs(lessons, SIMILAR_TITLE_THRESHOLD).map((p) => ({
    a: ref(byId.get(p.a.id) as HygieneLesson),
    b: ref(byId.get(p.b.id) as HygieneLesson),
    score: p.score,
  }));

  const required = lessons.filter((l) => lessonModeOf(l) === "required");
  const requiredOver = required.length > max ? { count: required.length, max, ids: required.map((l) => l.id) } : null;

  return { days, stale, ondemandNoKeywords, similarPairs, requiredOver };
}

export function signalCount(s: HygieneSignals): number {
  return s.stale.length + s.ondemandNoKeywords.length + s.similarPairs.length + (s.requiredOver ? 1 : 0);
}

/* ── 후보 묶음(LLM 입력) ─────────────────────────────────────────────── */

export type Cluster = { scopeKey: string; lessonIds: string[]; reasons: string[] };

export const scopeKeyOf = (l: { projectId: string | null; stack: string | null }): string =>
  l.projectId ? `project:${l.projectId}` : l.stack ? `stack:${l.stack}` : "global";

/**
 * 신호 → 묶음. 비슷한 제목 쌍은 union-find 로 한 묶음, 나머지는 레슨 하나씩, 필수 과다는 필수 전체 한 묶음.
 * 묶음의 scopeKey 는 첫 레슨의 범위(쌍이 범위를 넘나들면 첫 레슨 쪽).
 */
export function buildClusters(s: HygieneSignals, lessons: HygieneLesson[]): Cluster[] {
  const byId = new Map(teamLessons(lessons).map((l) => [l.id, l]));
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) && parent.get(r) !== r) r = parent.get(r) as string;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const p of s.similarPairs) union(p.a.id, p.b.id);

  const reasons = new Map<string, string[]>();
  const note = (id: string, r: string) => reasons.set(id, [...(reasons.get(id) ?? []), r]);
  for (const p of s.similarPairs) {
    note(p.a.id, `제목 비슷함(${p.score}) ↔ ${p.b.id}`);
    note(p.b.id, `제목 비슷함(${p.score}) ↔ ${p.a.id}`);
  }
  for (const l of s.stale) note(l.id, `최근 ${s.days}일 주입·조회 0회`);
  for (const l of s.ondemandNoKeywords) note(l.id, "ondemand 인데 키워드 없음");

  const groups = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const r = find(id);
    groups.set(r, [...(groups.get(r) ?? []), id]);
  }
  const clusters: Cluster[] = [];
  const inPair = new Set(parent.keys());
  for (const ids of groups.values()) {
    const first = byId.get(ids[0]);
    if (!first) continue;
    clusters.push({ scopeKey: scopeKeyOf(first), lessonIds: ids, reasons: ids.flatMap((id) => (reasons.get(id) ?? []).map((r) => `${id}: ${r}`)) });
  }
  const single = new Set([...s.stale, ...s.ondemandNoKeywords].map((l) => l.id).filter((id) => !inPair.has(id)));
  for (const id of single) {
    const l = byId.get(id);
    if (!l) continue;
    clusters.push({ scopeKey: scopeKeyOf(l), lessonIds: [id], reasons: (reasons.get(id) ?? []).map((r) => `${id}: ${r}`) });
  }
  if (s.requiredOver) {
    clusters.push({ scopeKey: "required", lessonIds: s.requiredOver.ids, reasons: [`필수 ${s.requiredOver.count}개 > ${s.requiredOver.max}개 — 꼭 필요한 것만 남기고 default 로 내릴 후보`] });
  }
  return clusters;
}

/** 묶음 → LLM 호출 단위. 같은 scopeKey 끼리 모으고 한 덩어리당 레슨 maxLessons 개를 넘지 않게 자른다(묶음은 쪼개지 않는다). */
export function chunkClusters(clusters: Cluster[], maxLessons = 25): Cluster[][] {
  const byScope = new Map<string, Cluster[]>();
  for (const c of clusters) byScope.set(c.scopeKey, [...(byScope.get(c.scopeKey) ?? []), c]);
  const chunks: Cluster[][] = [];
  for (const key of [...byScope.keys()].sort()) {
    let cur: Cluster[] = [];
    let n = 0;
    for (const c of byScope.get(key) as Cluster[]) {
      if (cur.length && n + c.lessonIds.length > maxLessons) {
        chunks.push(cur);
        cur = [];
        n = 0;
      }
      cur.push(c);
      n += c.lessonIds.length;
    }
    if (cur.length) chunks.push(cur);
  }
  return chunks;
}
