import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { findAssigneeProp, findDateProp, findStatusProp } from "@/lib/taskProps";
import { requireCtx } from "@/lib/workspace";
import { loadAccess, pageAccess, projectAccess, visibleOnly } from "@/lib/pageGuard";
import { hiddenPageIds } from "@/lib/pageAccess";
import { TASK_NOTE_EXCLUDE } from "@/lib/taskNotes";
import { resolveRouteByCwd } from "@/lib/ingest";

import { loadGraph } from "@/lib/graphLoad";
import { subgraph, renderKnowledgeMap, knowledgeMapLine } from "@/lib/graphInsights";
import { buildLessonSection, capLines, CONTEXT_BUDGET, gistOf, LESSON_BUDGET, lessonMinBudget, renderSubagentLessons } from "@/lib/lessonInject";
import { recordLessonInjection, injectionIds, briefInjectionIds } from "@/lib/lessonInspect/log";
import { renderBrief, sortTasksForContext } from "@/lib/contextBrief";
import { renderProjectDelta } from "@/lib/contextProject";
import { viewerPersonId } from "@/lib/viewerPerson";
import { accountSection, buildAccountLines } from "@/lib/envVault/sessionAccounts";
import { archivedPageIds } from "@/lib/pageArchive";
import { withReq } from "@/lib/log";
import { homedir } from "node:os";

export const runtime = "nodejs";

type Opt = { id: string; name: string };

/* GET /api/context?format=md|json&cwd=<path>
   워크스페이스를 Claude 세션이 읽을 수 있는 Markdown 컨텍스트로 내보낸다.
   (팀 레슨 · 보드 열린 태스크 · 문서 목록 · 승인된 결정 · 열린 리스크 · 용어집)
   cwd 를 주면 WorkspaceRouteRule 로 프로젝트를 해석해 해당 프로젝트 우선으로 필터한다(W3).
   compact=1 → 세션 훅 주입용. 전체를 ~7KB(CONTEXT_BUDGET) 안으로 줄인다(레슨은 제목·요약·id, 태스크는 내 담당 → 진행 중 순 ~700자,
   결정은 상위 N건+'외 N건', 지식 지도·문서·용어집은 개수 + MCP 안내 한 줄 — 목록은 필요할 때 MCP 로).
   Claude Code 는 큰 훅 출력을 파일로 빼고 앞 2KB 만 넣기 때문에, 크기 자체가 전달 여부를 가른다.
   brief=1 → resume·compact 훅용 ~2.5KB 요약(프로젝트·스택 레슨 제목+id, 내 담당 + 진행 중 상위 5건, 나머지는 개수 한 줄).
   compact=1 과 같이 오면 brief 가 우선. 렌더는 lib/contextBrief(순수).
   sections=lessons → SubagentStart 훅용 레슨 섹션만(필수 + cwd 프로젝트 범위 + 요청자 본인의 개인 레슨 제목+id, 예산 LESSON_BUDGET).
   keywords 에 `audience:main`(정확히, 소문자)이 있는 레슨은 메인 세션 전용이라 빼고 '메인 전용 N건 제외' 한 줄로만 센다(필수·기본 모두).
   보드·문서·결정·지식 지도는 읽지 않는다. 렌더는 lib/lessonInject.renderSubagentLessons(순수).
   sections=project → PostToolUse 훅용 프로젝트 델타(~3KB): 그 프로젝트·스택 범위 레슨(필수 먼저) + 계정 줄 + 내 담당·진행 중 태스크 +
   개수 한 줄. 세션 시작에 이미 들어간 전역·개인·필수(전역) 레슨과 지식 지도·용어집·문서 목록·결정은 싣지 않는다. 렌더는 lib/contextProject(순수).
   주입 기록 mode=project.
   다른 sections 값은 400. 없으면 기존 동작 그대로.
   format=json → { markdown, counts }, 기본 → text/markdown. */
export async function GET(request: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const url = new URL(request.url);
  const fmt = url.searchParams.get("format");
  const cwd = url.searchParams.get("cwd");
  const compact = url.searchParams.get("compact") === "1";
  const includeTaskNotes = url.searchParams.get("includeTaskNotes") === "1";
  const brief = url.searchParams.get("brief") === "1";
  const sections = url.searchParams.get("sections");
  if (sections !== null && sections !== "lessons" && sections !== "project")
    return NextResponse.json({ error: "sections 는 lessons|project 만 지원합니다." }, { status: 400 });

  // 보관(F2 문서·F10 프로젝트)은 주입하지 않는다 — 사이드바·검색과 같은 규칙(lib/pagesList·search).
  // 문서 보관은 조상 기반이라 보관 페이지가 하나라도 있을 때만 트리를 읽는다(대부분 count 한 번).
  const [archivedProjects, archivedPageCount] = await Promise.all([
    prisma.project.findMany({ where: { workspaceId, archivedAt: { not: null } }, select: { id: true } }),
    prisma.page.count({ where: { workspaceId, deletedAt: null, archivedAt: { not: null } } }),
  ]);
  const archivedProjectIds = archivedProjects.map((p) => p.id);
  const archivedIds =
    archivedPageCount > 0
      ? [...archivedPageIds(await prisma.page.findMany({ where: { workspaceId, deletedAt: null }, select: { id: true, parentId: true, archivedAt: true } }))]
      : [];
  // 보관 프로젝트 소속 행 제외. projectId null(미분류)은 남긴다 — notIn 만 쓰면 NULL 이 같이 빠진다.
  const notArchivedProject = archivedProjectIds.length
    ? { AND: [{ OR: [{ projectId: null }, { projectId: { notIn: archivedProjectIds } }] }] }
    : {};
  const notArchivedPage = { ...(archivedIds.length ? { id: { notIn: archivedIds } } : {}), ...notArchivedProject };

  // cwd → 프로젝트 스코프 (라우트룰, 없으면 워크스페이스 전역).
  // 보관 프로젝트를 가리키는 룰은 없는 것으로 친다 — 더 넓은 룰이 있으면 그쪽으로, 없으면 전역.
  let projectId: string | null = null;
  let projectName: string | null = null;
  let projectStack: string[] = [];
  if (cwd) {
    const rules = await prisma.workspaceRouteRule.findMany({
      where: { workspaceId },
      select: { cwdPrefix: true, workspaceId: true, projectId: true, priority: true },
    });
    const liveRules = rules.filter((r) => !r.projectId || !archivedProjectIds.includes(r.projectId));
    projectId = resolveRouteByCwd(cwd, liveRules)?.projectId ?? null;
    if (projectId) {
      const p = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true, stack: true } });
      projectName = p?.name ?? null;
      projectStack = p?.stack ?? [];
      if (!p) projectId = null;
    }
  }

  // 레슨: 전역 + (cwd 매핑 시) 해당 프로젝트 — 팀 작업규칙은 항상 주입된다 (W3 mem-9)
  // 개인 레슨은 이 요청의 사람(사람 = 본인, 에이전트 토큰 = 발급자) 것만 — 다른 사람 것은 admin 이어도 읽지 않는다.
  // ondemand·스택 불일치 등 세부 판정은 lib/lessonInject.lessonApplicability 가 한다(개수도 그 판정 뒤 숫자로).
  const personId = viewerPersonId(guard);
  const lessonWhere = {
    workspaceId,
    ...(projectId ? { OR: [{ projectId: null }, { projectId }] } : {}),
    AND: [{ OR: [{ userId: null }, ...(personId ? [{ userId: personId }] : [])] }],
  };

  // sections=lessons: 서브에이전트(SubagentStart 훅)에 세션 레포 레슨만 — 필수 + 이 프로젝트 범위 + 요청자 개인 레슨(제목+id).
  // 개인 습관은 MEMORY.md 에서 레슨으로 옮겨 가는 중이라 여기서 싣는다(2026-10-20). 전역 기본·스택은 에이전트 정의·role 레슨이 맡는다.
  if (sections === "lessons") {
    const all = await prisma.lesson.findMany({
      where: lessonWhere,
      orderBy: { updatedAt: "desc" },
      select: { id: true, title: true, body: true, projectId: true, stack: true, userId: true, mode: true, keywords: true },
      take: 500,
    });
    const r = renderSubagentLessons({ lessons: all, projectId, projectName, projectStack, personId, budget: LESSON_BUDGET });
    const markdown = r.lines.join("\n");
    if (url.searchParams.get("inspect") !== "1") {
      void recordLessonInjection({ workspaceId, actorName: guard.actor?.name, cwd, projectId, via: url.searchParams.get("via"), mode: "compact", ids: injectionIds(r.report), chars: markdown.length });
    }
    return fmt === "json"
      ? NextResponse.json({ markdown, counts: { lessons: r.count } })
      : new NextResponse(markdown, { headers: { "content-type": "text/markdown; charset=utf-8" } });
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
    (projectId ? await visibleBoard({ kind: "database", workspaceId, projectId, deletedAt: null, ...notArchivedPage }) : null) ??
    (await visibleBoard({ kind: "database", workspaceId, deletedAt: null, ...notArchivedPage }));
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
  const docWhere = { kind: "doc" as const, workspaceId, deletedAt: null, ...projFilter, ...notArchivedPage, ...(includeTaskNotes ? {} : TASK_NOTE_EXCLUDE) };
  const decisionWhere = { workspaceId, status: "accepted" as const, ...projFilter, ...notArchivedProject };
  const riskWhere = { workspaceId, status: "open" as const, ...projFilter, ...notArchivedProject };
  // 개수는 count 로 — 목록 take(50/30/100/500)에 묶이지 않고, brief 는 목록을 아예 읽지 않는다.
  // 문서 개수는 볼 수 없는 페이지를 where 로 밀어 넣어 visibleOnly 와 같은 결과를 낸다.
  const hiddenDocIds = [...archivedIds, ...hiddenPageIds(access)];
  const docCountWhere = { ...docWhere, ...(hiddenDocIds.length ? { id: { notIn: hiddenDocIds } } : {}) };
  // 계정 줄(P3c) — 이 프로젝트의 env 금고 반영 대상이 기대하는 계정(계정 착각 방지). 훅 주입(compact·brief·project)에만.
  // 프로젝트를 볼 수 없으면(제한 프로젝트) 넣지 않는다. 조회 실패는 섹션만 생략.
  const loadAccountTargets = async (want: boolean): Promise<{ kind: string; config: unknown; account: unknown }[]> => {
    if (!projectId || !want || projectAccess(access, projectId) === "none") return [];
    try {
      return await prisma.envTarget.findMany({
        where: { workspaceId, projectId },
        orderBy: [{ kind: "asc" }, { env: "asc" }, { createdAt: "asc" }],
        select: { kind: true, config: true, account: true },
      });
    } catch (e) {
      // 오류 본문은 남기지 않는다(계정·설정 값이 섞일 수 있다) — 이름만
      withReq(request).warn("context.account_lines_skipped", { msg: "계정 줄 생략", errName: e instanceof Error ? e.name : typeof e });
      return [];
    }
  };

  // sections=project: PostToolUse 델타 — 레슨(프로젝트·스택)·계정·태스크·개수만. 목록·지식 지도는 읽지 않는다.
  if (sections === "project") {
    const [lessons, nDocs, nDecisions, targets] = await Promise.all([
      prisma.lesson.findMany({
        where: lessonWhere,
        orderBy: { updatedAt: "desc" },
        select: { id: true, title: true, body: true, projectId: true, stack: true, userId: true, mode: true },
        take: 500,
      }),
      prisma.page.count({ where: docCountWhere }),
      prisma.decision.count({ where: decisionWhere }),
      loadAccountTargets(true),
    ]);
    const r = renderProjectDelta({
      workspaceName: ws?.name ?? "TeamSpace",
      projectId,
      projectName,
      projectStack,
      lessons,
      personId,
      tasks,
      me: [guard.actor?.name ?? "", guard.userId],
      counts: { tasks: tasks.length, docs: nDocs, decisions: nDecisions },
      accountLines: buildAccountLines(targets, { home: homedir() }),
    });
    if (url.searchParams.get("inspect") !== "1") {
      void recordLessonInjection({ workspaceId, actorName: guard.actor?.name, cwd, projectId, via: url.searchParams.get("via"), mode: "project", ids: r.ids, chars: r.markdown.length });
    }
    return fmt === "json"
      ? NextResponse.json({ markdown: r.markdown, counts: { lessons: r.ids.gistIds.length + r.ids.titleIds.length + r.ids.omittedIds.length, tasks: tasks.length, docs: nDocs, decisions: nDecisions } })
      : new NextResponse(r.markdown, { headers: { "content-type": "text/markdown; charset=utf-8" } });
  }

  const [docs, decisions, risks, glossary, lessons, nDocs, nDecisions, nRisks, nGlossary, nLessons] = await Promise.all([
    brief || compact ? [] : prisma.page.findMany({ where: docWhere, orderBy: { updatedAt: "desc" }, select: { id: true, title: true, updatedAt: true }, take: 50 }),
    brief ? [] : prisma.decision.findMany({ where: decisionWhere, orderBy: { decidedAt: "desc" }, select: { title: true, decision: true }, take: 30 }),
    brief ? [] : prisma.risk.findMany({ where: riskWhere, orderBy: { createdAt: "desc" }, select: { title: true, severity: true }, take: 30 }),
    brief || compact ? [] : prisma.glossaryTerm.findMany({ where: { workspaceId }, orderBy: { term: "asc" }, select: { term: true, definition: true }, take: 100 }),
    // 섹션(전역/프로젝트) 나누기와 예산은 lib/lessonInject 가 한다 — 여기서 개수로 자르지 않는다.
    prisma.lesson.findMany({
      where: lessonWhere,
      orderBy: { updatedAt: "desc" },
      select: { id: true, title: true, body: true, projectId: true, stack: true, userId: true, mode: true },
      take: 500,
    }),
    prisma.page.count({ where: docCountWhere }),
    prisma.decision.count({ where: decisionWhere }),
    prisma.risk.count({ where: riskWhere }),
    prisma.glossaryTerm.count({ where: { workspaceId } }),
    prisma.lesson.count({ where: lessonWhere }),
  ]);

  const accountTargets = await loadAccountTargets(compact || brief);
  const home = homedir();

  const visibleDocs = visibleOnly(access, docs);
  const me = [guard.actor?.name ?? "", guard.userId];
  const counts = { lessons: nLessons, tasks: tasks.length, docs: nDocs, decisions: nDecisions, risks: nRisks, glossary: nGlossary };
  const respond = (markdown: string, extra?: object) =>
    fmt === "json"
      ? NextResponse.json({ markdown, counts, ...extra })
      : new NextResponse(markdown, { headers: { "content-type": "text/markdown; charset=utf-8" } });

  // 레슨 주입 기록(설정 › 레슨 주입 점검) — 훅 주입(compact·brief)마다 1행, fire-and-forget.
  // inspect=1 은 점검 화면의 시뮬레이션 호출이라 기록하지 않고 레슨별 상태 보고서를 JSON 에 싣는다.
  const inspect = url.searchParams.get("inspect") === "1";
  const logInjection = (mode: "compact" | "brief", ids: Parameters<typeof recordLessonInjection>[0]["ids"], chars: number) => {
    if (inspect) return;
    void recordLessonInjection({ workspaceId, actorName: guard.actor?.name, cwd, projectId, via: url.searchParams.get("via"), mode, ids, chars });
  };

  // brief: 지식 지도(그래프 로드)도 건너뛴다 — 이어가는 세션엔 개수만 주고, 훅 3초 예산도 아낀다.
  if (brief) {
    const md = renderBrief({
      workspaceName: ws?.name ?? "TeamSpace",
      projectId,
      projectName,
      projectStack,
      lessons,
      personId,
      tasks,
      me,
      counts,
      accountLines: buildAccountLines(accountTargets, { home, maxLines: 1, maxChars: 120 }),
    });
    logInjection("brief", briefInjectionIds(md, lessons, projectId, projectStack, personId), md.length);
    return respond(md);
  }

  const L: string[] = [];
  L.push(`# 워크스페이스: ${ws?.name ?? "TeamSpace"}${projectName ? ` · 프로젝트: ${projectName}` : ""}`);
  L.push(`_Claude 세션 공유 컨텍스트 (읽기 전용 스냅샷${projectName ? `, cwd→${projectName} 스코프` : ""})_`);
  L.push("");

  // 계정 줄은 머리말 바로 뒤(레슨 앞). L 에 먼저 넣어 두므로 레슨 예산(restChars)에서 그만큼 빠진다 — 대상이 없으면 빈 배열.
  if (compact) L.push(...accountSection(buildAccountLines(accountTargets, { home })));

  const headerLen = L.length; // 레슨은 나머지 섹션을 다 그린 뒤 이 자리에 끼운다(남는 예산을 레슨에 주기 위해)

  // 지식 지도(Graphify 차용) — 허브·군집으로 '무엇부터 읽을지'를 준다. 설계: 지식 그래프 확장(Graphify 차용).
  // cwd→프로젝트면 그 프로젝트 문서만. 그래프 실패가 세션 컨텍스트 전체를 막으면 안 된다 → 섹션만 생략.
  // SessionStart 훅은 3초에 끊긴다 → 그래프 로드는 800ms 안에 못 끝나면 섹션만 버린다.
  // 지도는 한 번만 그리고, compact 예산을 맞추느라 나머지 섹션을 다시 그릴 때는 자르기만 다시 한다.
  let mapLines: string[] | null = null; // compact 는 개수 한 줄(knowledgeMapLine), full 은 허브·군집 목록
  let graphTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      graphTimer = setTimeout(() => reject(new Error("graph load timeout 800ms")), 800);
    });
    let g = await Promise.race([loadGraph(guard, access), timeout]);
    if (archivedIds.length || archivedProjectIds.length) {
      const hidden = new Set([...archivedIds, ...archivedProjectIds]);
      g = subgraph(g, (n) => !hidden.has(n.id) && !(n.projectId && hidden.has(n.projectId)));
    }
    if (projectId) g = subgraph(g, (n) => n.type === "doc" && n.projectId === projectId);
    mapLines = compact ? [knowledgeMapLine(g), ""] : renderKnowledgeMap(g, { hubN: 20, commN: 10 });
  } catch (e) {
    withReq(request).warn("context.knowledge_map_skipped", { msg: "지식 지도 생략", err: e });
  } finally {
    clearTimeout(graphTimer);
  }

  /** 레슨을 뺀 나머지 섹션. compact 는 섹션마다 상한(cap × scale)을 두고 넘친 개수를 적는다. full(AI 연결 화면·내보내기)은 전부.
      scale < 1 = 레슨 최소 몫(필수 우선)을 먼저 떼고 나머지를 줄여야 할 때. */
  const renderRest = (scale: number): string[] => {
    const R: string[] = [];
    const cap = (n: number) => Math.floor(n * scale);
    const section = (title: string, lines: string[], empty: string, max: number, moreHint: string) => {
      R.push(title);
      if (lines.length === 0) R.push(empty);
      const r = compact ? capLines(lines, cap(max)) : { lines, omitted: 0 };
      R.push(...r.lines);
      if (r.omitted) R.push(`- … 외 ${r.omitted}건 (${moreHint})`);
      R.push("");
    };

    section(
      `## 태스크 보드 — 열린 ${tasks.length}건`,
      (compact ? sortTasksForContext(tasks, me) : tasks).map((t) => {
        const meta = [t.status, t.assignee, t.due ? `마감 ${t.due}` : null].filter(Boolean).join(" · ");
        return `- ${t.title}${meta ? ` — ${meta}` : ""}`;
      }),
      "- (열린 태스크 없음)",
      700,
      "MCP `task_list`",
    );

    // compact: 문서 목록은 한 줄 — id 없는 제목은 바로 열 수 없어 쓸모가 적다(MCP doc_list 가 id 를 준다).
    if (compact) R.push(`## 문서 (${counts.docs}) — 목록은 MCP \`doc_list\``, "");
    else section(`## 문서 (${counts.docs})`, visibleDocs.map((d) => `- ${d.title}`), "- (없음)", 0, "");

    section(
      `## 결정 — 승인됨 (${counts.decisions})`,
      decisions.map((d) => (compact ? `- ${d.title}${d.decision ? `: ${gistOf(d.decision, 80)}` : ""}` : `- ${d.title}${d.decision ? `: ${d.decision}` : ""}`)),
      "- (없음)",
      1000,
      "MCP `search`",
    );

    section(`## 리스크 — 열림 (${counts.risks})`, risks.map((r) => `- [${r.severity}] ${r.title}`), "- (없음)", 400, "MCP `search`");

    if (mapLines) R.push(...mapLines);

    if (compact) {
      R.push(`## 용어집 (${counts.glossary}) — 정의는 MCP \`search\``, "");
    } else {
      section(`## 용어집 (${counts.glossary})`, glossary.map((g) => `- **${g.term}**: ${g.definition ?? ""}`), "- (없음)", 0, "");
    }
    return R;
  };

  // compact: 전체(CONTEXT_BUDGET) 안에 맞춘다 — 레슨 섹션이 최소 몫(필수 레슨 요약 + 다른 섹션 '외 N개', 최소 LESSON_BUDGET)을
  // 먼저 갖고, 나머지 섹션이 넘치면 상한을 줄여 다시 그린다(필수 우선). 레슨은 남는 만큼 더 받는다 — lib/lessonInject.buildLessonSection.
  // 점검 화면(GET /api/lessons/inspect)이 같은 함수를 이 라우트를 통해 부른다(드리프트 방지).
  const lessonIn = { lessons, projectId, projectName, projectStack, personId, compact };
  const head = L.join("\n").length;
  let rest = renderRest(1);
  if (compact) {
    const restMax = CONTEXT_BUDGET - 1 - lessonMinBudget(lessonIn);
    const restLen = () => head + 1 + rest.join("\n").length;
    // 상한은 섹션별이라 비율대로 줄여도 제목·'외 N건' 줄은 남는다 — 몇 번 좁혀 보고, 끝까지 넘치면 상한 0(제목·개수만).
    let scale = 1;
    for (let k = 0; k < 5 && restLen() > restMax; k++) {
      scale = k === 4 ? 0 : scale * Math.max(0, restMax - head) / Math.max(1, restLen() - head) * 0.95;
      rest = renderRest(scale);
    }
  }
  L.push(...rest);
  const lessonSec = buildLessonSection({ ...lessonIn, restChars: L.join("\n").length });
  L.splice(headerLen, 0, ...lessonSec.lines);
  const markdown = L.join("\n");
  if (compact) logInjection("compact", injectionIds(lessonSec.report), markdown.length);
  return respond(markdown, inspect ? { lessonReport: { ...lessonSec.report, lessonMarkdown: lessonSec.lines.join("\n"), totalChars: markdown.length, projectId, projectName, projectStack } } : undefined);
}
