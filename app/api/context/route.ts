import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { findAssigneeProp, findDateProp, findStatusProp } from "@/lib/taskProps";
import { requireCtx } from "@/lib/workspace";
import { loadAccess, pageAccess, visibleOnly } from "@/lib/pageGuard";
import { resolveRouteByCwd } from "@/lib/ingest";

import { loadGraph } from "@/lib/graphLoad";
import { subgraph, renderKnowledgeMap } from "@/lib/graphInsights";
import { renderLessons, capLines, gistOf, LESSON_BUDGET, CONTEXT_BUDGET } from "@/lib/lessonInject";

export const runtime = "nodejs";

type Opt = { id: string; name: string };

/* GET /api/context?format=md|json&cwd=<path>
   워크스페이스를 Claude 세션이 읽을 수 있는 Markdown 컨텍스트로 내보낸다.
   (팀 레슨 · 보드 열린 태스크 · 문서 목록 · 승인된 결정 · 열린 리스크 · 용어집)
   cwd 를 주면 WorkspaceRouteRule 로 프로젝트를 해석해 해당 프로젝트 우선으로 필터한다(W3).
   compact=1 → 세션 훅 주입용. 전체를 ~9KB 안으로 줄인다(레슨은 제목·요약·id, 나머지는 상위 N건+'외 N건').
   Claude Code 는 큰 훅 출력을 파일로 빼고 앞 2KB 만 넣기 때문에, 크기 자체가 전달 여부를 가른다.
   format=json → { markdown, counts }, 기본 → text/markdown. */
export async function GET(request: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const url = new URL(request.url);
  const fmt = url.searchParams.get("format");
  const cwd = url.searchParams.get("cwd");
  const compact = url.searchParams.get("compact") === "1";

  // cwd → 프로젝트 스코프 (라우트룰, 없으면 워크스페이스 전역)
  let projectId: string | null = null;
  let projectName: string | null = null;
  let projectStack: string[] = [];
  if (cwd) {
    const rules = await prisma.workspaceRouteRule.findMany({
      where: { workspaceId },
      select: { cwdPrefix: true, workspaceId: true, projectId: true, priority: true },
    });
    projectId = resolveRouteByCwd(cwd, rules)?.projectId ?? null;
    if (projectId) {
      const p = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true, stack: true } });
      projectName = p?.name ?? null;
      projectStack = p?.stack ?? [];
      if (!p) projectId = null;
    }
  }

  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } });

  // 보드 열린 태스크.
  //
  // 종전엔 projectId 조건 없이 '워크스페이스 첫 database' 를 무조건 집었다. 그런데
  // 아래 출력 헤더(:88-90)는 'cwd→<프로젝트> 스코프'라고 찍으므로, 다른 프로젝트의
  // 태스크가 그 프로젝트 것인 양 세션에 주입됐다(전수조사 D8). 프로젝트가 정해졌으면
  // 그 프로젝트 보드를 쓰고, 없을 때만 첫 보드로 물러난다.
  // D3: 세션 컨텍스트는 에이전트에게 **자동 주입**된다 — 여기서 새면 사용자가
  // 요청하지도 않은 문서 제목·태스크가 프롬프트에 실려 나간다. 가장 조용한 누출 경로다.
  const access = await loadAccess(guard);
  const visibleBoard = async (where: object) =>
    (await prisma.page.findMany({ where, orderBy: { createdAt: "asc" }, select: { id: true } })).find(
      (b) => pageAccess(access, b.id) !== "none",
    ) ?? null;
  const db =
    (projectId ? await visibleBoard({ kind: "database", workspaceId, projectId, deletedAt: null }) : null) ??
    (await visibleBoard({ kind: "database", workspaceId, deletedAt: null }));
  const tasks: { title: string; status: string | null; due: string | null; assignee: string | null }[] = [];
  if (db) {
    const [props, rows] = await Promise.all([
      prisma.dbProperty.findMany({ where: { databasePageId: db.id }, orderBy: { position: "asc" } }),
      prisma.dbRow.findMany({ where: { databasePageId: db.id }, orderBy: { position: "asc" } }),
    ]);
    // 속성 해석은 공용 헬퍼로 — 자체 구현이 lib/taskProps 와 갈라져 있었고,
    // 특히 담당자를 text 로만 찾아 person 타입 보드에서 항상 빈 값이었다(D8).
    // claim 라우트와 같은 형태로 좁혀서 넘긴다(Prisma JsonValue → PropLite.config)
    const propsLite = props.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type as string,
      config: p.config as { options?: { id: string; name: string }[] },
    }));
    const titleProp = props.find((p) => p.type === "text") ?? props[0] ?? null;
    const statusProp = findStatusProp(propsLite);
    const dateProp = findDateProp(propsLite);
    const asgnProp = findAssigneeProp(propsLite);
    const statusOpts: Opt[] = statusProp ? (((statusProp.config as { options?: Opt[] })?.options) ?? []) : [];
    const doneName = statusOpts[statusOpts.length - 1]?.name;
    for (const r of rows) {
      const p = r.props as Record<string, unknown>;
      const sName = statusProp ? statusOpts.find((o) => o.id === p[statusProp.id])?.name ?? null : null;
      if (sName && doneName && sName === doneName) continue; // 완료는 제외(열린 것만)
      tasks.push({
        title: (titleProp ? (p[titleProp.id] as string) : "") || "(제목 없음)",
        status: sName,
        due: dateProp ? ((p[dateProp.id] as string) ?? null) : null,
        assignee: asgnProp ? ((p[asgnProp.id] as string) ?? null) : null,
      });
    }
  }

  const projFilter = projectId ? { projectId } : {};
  const [docs, decisions, risks, glossary, lessons] = await Promise.all([
    prisma.page.findMany({ where: { kind: "doc", workspaceId, deletedAt: null, ...projFilter }, orderBy: { updatedAt: "desc" }, select: { id: true, title: true, updatedAt: true }, take: 50 }),
    prisma.decision.findMany({ where: { workspaceId, status: "accepted", ...projFilter }, orderBy: { decidedAt: "desc" }, select: { title: true, decision: true }, take: 30 }),
    prisma.risk.findMany({ where: { workspaceId, status: "open", ...projFilter }, orderBy: { createdAt: "desc" }, select: { title: true, severity: true }, take: 30 }),
    prisma.glossaryTerm.findMany({ where: { workspaceId }, orderBy: { term: "asc" }, select: { term: true, definition: true }, take: 100 }),
    // 레슨: 전역 + (cwd 매핑 시) 해당 프로젝트 — 팀 작업규칙은 항상 주입된다 (W3 mem-9)
    // 섹션(전역/프로젝트) 나누기와 예산은 lib/lessonInject 가 한다 — 여기서 개수로 자르지 않는다.
    prisma.lesson.findMany({
      where: { workspaceId, ...(projectId ? { OR: [{ projectId: null }, { projectId }] } : {}) },
      orderBy: { updatedAt: "desc" },
      select: { id: true, title: true, body: true, projectId: true, stack: true },
      take: 500,
    }),
  ]);

  const L: string[] = [];
  L.push(`# 워크스페이스: ${ws?.name ?? "TeamSpace"}${projectName ? ` · 프로젝트: ${projectName}` : ""}`);
  L.push(`_Claude 세션 공유 컨텍스트 (읽기 전용 스냅샷${projectName ? `, cwd→${projectName} 스코프` : ""})_`);
  L.push("");

  const headerLen = L.length; // 레슨은 나머지 섹션을 다 그린 뒤 이 자리에 끼운다(남는 예산을 레슨에 주기 위해)

  // compact: 섹션마다 상한을 두고 넘친 개수를 적는다. full(AI 연결 화면·내보내기)은 전부.
  const section = (title: string, lines: string[], empty: string, cap: number, moreHint: string) => {
    L.push(title);
    if (lines.length === 0) L.push(empty);
    const r = compact ? capLines(lines, cap) : { lines, omitted: 0 };
    L.push(...r.lines);
    if (r.omitted) L.push(`- … 외 ${r.omitted}건 (${moreHint})`);
    L.push("");
  };

  section(
    `## 태스크 보드 — 열린 ${tasks.length}건`,
    tasks.map((t) => {
      const meta = [t.status, t.assignee, t.due ? `마감 ${t.due}` : null].filter(Boolean).join(" · ");
      return `- ${t.title}${meta ? ` — ${meta}` : ""}`;
    }),
    "- (열린 태스크 없음)",
    1400,
    "MCP `task_list`",
  );

  const visibleDocs = visibleOnly(access, docs);
  section(`## 문서 (${visibleDocs.length})`, visibleDocs.map((d) => `- ${d.title}`), "- (없음)", 700, "MCP `doc_list`");

  section(
    `## 결정 — 승인됨 (${decisions.length})`,
    decisions.map((d) => (compact ? `- ${d.title}${d.decision ? `: ${gistOf(d.decision, 80)}` : ""}` : `- ${d.title}${d.decision ? `: ${d.decision}` : ""}`)),
    "- (없음)",
    1000,
    "MCP `search`",
  );

  section(`## 리스크 — 열림 (${risks.length})`, risks.map((r) => `- [${r.severity}] ${r.title}`), "- (없음)", 400, "MCP `search`");

  // 지식 지도(Graphify 차용) — 허브·군집으로 '무엇부터 읽을지'를 준다. 설계: 지식 그래프 확장(Graphify 차용).
  // cwd→프로젝트면 그 프로젝트 문서만. 그래프 실패가 세션 컨텍스트 전체를 막으면 안 된다 → 섹션만 생략.
  // SessionStart 훅은 3초에 끊긴다 → 그래프 로드는 800ms 안에 못 끝나면 섹션만 버린다.
  let graphTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      graphTimer = setTimeout(() => reject(new Error("graph load timeout 800ms")), 800);
    });
    let g = await Promise.race([loadGraph(guard, access), timeout]);
    if (projectId) g = subgraph(g, (n) => n.type === "doc" && n.projectId === projectId);
    const map = renderKnowledgeMap(g, compact ? { hubN: 8, commN: 5 } : { hubN: 20, commN: 10 });
    if (compact) {
      // 레슨 예산을 잠식하지 않게 ~1200자로 자른다(제목 줄은 유지)
      const body = capLines(map.slice(1), 1200);
      L.push(map[0], ...body.lines);
      if (body.omitted) L.push("");
    } else {
      L.push(...map);
    }
  } catch (e) {
    console.error("[context] 지식 지도 생략:", e);
  } finally {
    clearTimeout(graphTimer);
  }

  if (compact) {
    L.push(`## 용어집 (${glossary.length})`);
    const terms = capLines(glossary.map((g) => g.term), 500);
    L.push(terms.lines.length ? `${terms.lines.join(", ")}${terms.omitted ? ` 외 ${terms.omitted}개` : ""} — 정의는 MCP \`search\`` : "- (없음)");
    L.push("");
  } else {
    section(`## 용어집 (${glossary.length})`, glossary.map((g) => `- **${g.term}**: ${g.definition ?? ""}`), "- (없음)", 0, "");
  }

  // compact: 전체 예산(CONTEXT_BUDGET)에서 다른 섹션이 쓰고 남은 만큼을 레슨에 준다(최소 LESSON_BUDGET).
  // 태스크가 없는 레포(로요)는 레슨이 더 들어가고, 태스크가 많은 레포는 레슨이 최소 몫을 지킨다.
  const lessonBudget = Math.max(LESSON_BUDGET, CONTEXT_BUDGET - L.join("\n").length - 400);
  L.splice(headerLen, 0, ...renderLessons({ lessons, projectId, projectName, projectStack, mode: compact ? "compact" : "full", budget: lessonBudget }));

  const markdown = L.join("\n");
  const counts = { lessons: lessons.length, tasks: tasks.length, docs: visibleDocs.length, decisions: decisions.length, risks: risks.length, glossary: glossary.length };

  if (fmt === "json") return NextResponse.json({ markdown, counts });
  return new NextResponse(markdown, { headers: { "content-type": "text/markdown; charset=utf-8" } });
}
