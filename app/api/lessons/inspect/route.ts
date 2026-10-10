import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { resolveRouteByCwd } from "@/lib/ingest";
import { buildLessonSection, CONTEXT_BUDGET, LESSON_BUDGET, lessonApplicability, lessonModeOf, lessonScopeOf, type LessonRenderReport, type LessonStatus, type LessonScope, type NotApplicableReason } from "@/lib/lessonInject";
import { personalLessonWhere } from "@/lib/lessonAccess";
import { viewerPersonId } from "@/lib/viewerPerson";
import { linkChecks } from "@/lib/lessonInspect/analyze";
import { GET as contextGET } from "@/app/api/context/route";

export const runtime = "nodejs";

type ContextReport = LessonRenderReport & {
  restChars: number;
  lessonMarkdown: string;
  totalChars: number;
  projectId: string | null;
  projectName: string | null;
  projectStack: string[];
};

const LINK_WINDOW_DAYS = 30;

/**
 * GET /api/lessons/inspect?projectId=|cwd= → 레슨 주입 점검(편집자 이상).
 *   시뮬레이터: 세션 훅 주입(/api/context?compact=1)과 **같은 라우트·같은 함수**로 만든 레슨 섹션 미리보기,
 *     레슨별 상태(gist 요약 포함 · title 제목만 · omitted '외 N개' · not_applicable 해당 없음), 섹션별 예산 사용.
 *     내부적으로 /api/context 핸들러를 inspect=1 로 불러(기록 안 남김) 다른 섹션이 쓴 글자 수까지 실제와 같게 맞춘다.
 *   projectId 만 주면 그 프로젝트를 가리키는 route-rule 의 cwd 로 시뮬레이션한다. 규칙이 없으면 실제로는 주입되지 않으므로
 *     resolution='project_unmapped' 로 표시하고 워크스페이스 기본 컨텍스트의 나머지 분량으로 추정한다.
 *   범위·주입 방식: 레슨별 scope(personal|project|stack|global)·mode(required|default|ondemand). 시뮬레이션은 **요청한 사람**
 *     (에이전트 토큰이면 발급자)의 세션으로 한다 — 개인 레슨은 그 사람 것만 들어가고, admin 이 보는 다른 사람의 개인 레슨은
 *     not_applicable(other_person) 으로 보인다. ondemand 는 not_applicable(ondemand).
 *   연결 점검: 최근 30일 주입 cwd 중 미매핑 · stack 빈 프로젝트 · 맞는 프로젝트 없는 스택 레슨 · 없는 프로젝트를 가리키는 route-rule.
 */
export async function GET(request: Request) {
  const guard = await requireCtx("editor");
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const personId = viewerPersonId(guard);
  const personal = personalLessonWhere({ personId, role: guard.role });
  const url = new URL(request.url);
  const cwdParam = url.searchParams.get("cwd")?.trim() || null;
  const projectParam = url.searchParams.get("projectId")?.trim() || null;

  const since = new Date(Date.now() - LINK_WINDOW_DAYS * 86_400_000);
  const [rules, projects, lessons, cwdGroups] = await Promise.all([
    prisma.workspaceRouteRule.findMany({ where: { workspaceId }, select: { id: true, cwdPrefix: true, projectId: true, priority: true, workspaceId: true } }),
    prisma.project.findMany({ where: { workspaceId, archivedAt: null }, orderBy: { position: "asc" }, select: { id: true, name: true, stack: true } }),
    prisma.lesson.findMany({
      where: { workspaceId, ...(personal ? { AND: [personal] } : {}) },
      orderBy: { updatedAt: "desc" },
      select: { id: true, title: true, body: true, projectId: true, stack: true, userId: true, mode: true, updatedAt: true },
      take: 500,
    }),
    prisma.lessonInjection.groupBy({
      by: ["cwd"],
      where: { workspaceId, createdAt: { gte: since }, cwd: { not: null } },
      _count: { _all: true },
      _max: { createdAt: true },
      take: 500,
      orderBy: { cwd: "asc" },
    }),
  ]);
  const projName = new Map(projects.map((p) => [p.id, p.name]));

  // ── 어떤 cwd 로 시뮬레이션할지 ─────────────────────────────────────
  let simCwd: string | null = null;
  let resolution: "cwd" | "project_rule" | "project_unmapped" | "none" = "none";
  if (cwdParam) {
    simCwd = cwdParam;
    resolution = "cwd";
  } else if (projectParam) {
    if (!projName.has(projectParam)) return NextResponse.json({ error: "프로젝트를 찾을 수 없습니다." }, { status: 400 });
    // 이 프로젝트로 실제 해석되는 규칙의 cwd(우선순위 높은 것부터)
    const own = rules.filter((r) => r.projectId === projectParam).sort((a, b) => b.priority - a.priority || b.cwdPrefix.length - a.cwdPrefix.length);
    const hit = own.find((r) => resolveRouteByCwd(r.cwdPrefix, rules)?.projectId === projectParam);
    if (hit) {
      simCwd = hit.cwdPrefix;
      resolution = "project_rule";
    } else {
      resolution = "project_unmapped";
    }
  }

  // ── 실제 주입 경로로 시뮬레이션(/api/context, inspect=1 = 기록 안 함) ──
  const q = new URLSearchParams({ format: "json", compact: "1", inspect: "1" });
  if (simCwd) q.set("cwd", simCwd);
  const res = await contextGET(new Request(`${url.origin}/api/context?${q}`, { headers: request.headers }));
  if (!res.ok) return NextResponse.json({ error: "컨텍스트 시뮬레이션에 실패했습니다." }, { status: 502 });
  const ctx = (await res.json()) as { lessonReport?: ContextReport };
  let rep = ctx.lessonReport;
  if (!rep) return NextResponse.json({ error: "컨텍스트 시뮬레이션 보고서가 없습니다." }, { status: 502 });

  if (resolution === "project_unmapped" && projectParam) {
    // 매핑이 없으면 실제 세션엔 이 프로젝트 레슨이 안 들어간다 — '매핑했다면' 어떻게 들어갈지 추정해 보여 준다.
    const p = projects.find((x) => x.id === projectParam)!;
    const scoped = lessons.filter((l) => !l.projectId || l.projectId === p.id);
    const sec = buildLessonSection({ lessons: scoped, projectId: p.id, projectName: p.name, projectStack: p.stack, personId, compact: true, restChars: rep.restChars });
    rep = {
      ...sec.report,
      lessonMarkdown: sec.lines.join("\n"),
      totalChars: rep.totalChars - rep.chars + sec.report.chars,
      projectId: p.id,
      projectName: p.name,
      projectStack: p.stack,
    };
  }

  // 시뮬레이션에 안 실린 레슨(다른 프로젝트·다른 사람의 개인 레슨)은 not_applicable 로 채운다 — 사유는 같은 판정 함수로.
  const statusById = new Map(rep.statuses.map((s) => [s.id, s]));
  const simScope = { projectId: rep.projectId, projectStack: rep.projectStack, personId };
  const rows = lessons.map((l) => {
    const s = statusById.get(l.id);
    const scope: LessonScope = s?.scope ?? lessonScopeOf(l);
    const status: LessonStatus = s?.status ?? "not_applicable";
    const reason: NotApplicableReason | null = s?.reason ?? (s ? null : (lessonApplicability(l, simScope) ?? "other_project"));
    return {
      id: l.id,
      title: l.title,
      scope,
      mode: lessonModeOf(l),
      personal: !!l.userId,
      projectId: l.projectId,
      projectName: l.projectId ? (projName.get(l.projectId) ?? null) : null,
      stack: l.stack,
      status,
      reason,
      updatedAt: l.updatedAt.toISOString(),
    };
  });
  const statusCounts = { gist: 0, title: 0, omitted: 0, not_applicable: 0 } as Record<LessonStatus, number>;
  for (const r of rows) statusCounts[r.status]++;
  const modeCounts = { required: 0, default: 0, ondemand: 0 };
  const scopeCounts = { personal: 0, project: 0, stack: 0, global: 0 } as Record<LessonScope, number>;
  for (const r of rows) {
    modeCounts[r.mode]++;
    scopeCounts[r.scope]++;
  }

  const checks = linkChecks({
    rules,
    projects,
    lessons: lessons.map((l) => ({ id: l.id, title: l.title, projectId: l.projectId, stack: l.stack })),
    recentCwds: cwdGroups.filter((g) => g.cwd).map((g) => ({ cwd: g.cwd as string, count: g._count._all, lastAt: g._max.createdAt ?? since })),
  });

  return NextResponse.json(
    {
      resolved: {
        resolution,
        cwd: simCwd,
        projectId: rep.projectId,
        projectName: rep.projectName,
        projectStack: rep.projectStack,
      },
      budget: {
        contextBudget: CONTEXT_BUDGET,
        lessonMinBudget: LESSON_BUDGET,
        lessonBudget: rep.budget,
        lessonChars: rep.chars,
        restChars: rep.restChars,
        totalChars: rep.totalChars,
      },
      sections: rep.sections,
      preview: rep.lessonMarkdown,
      statusCounts,
      modeCounts,
      scopeCounts,
      lessons: rows,
      linkChecks: { windowDays: LINK_WINDOW_DAYS, ...checks },
      projects: projects.map((p) => ({ id: p.id, name: p.name, stack: p.stack })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
