import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { resolveRouteByCwd } from "@/lib/ingest";

export const runtime = "nodejs";

type Opt = { id: string; name: string };

/* GET /api/context?format=md|json&cwd=<path>
   워크스페이스를 Claude 세션이 읽을 수 있는 Markdown 컨텍스트로 내보낸다.
   (팀 레슨 · 보드 열린 태스크 · 문서 목록 · 승인된 결정 · 열린 리스크 · 용어집)
   cwd 를 주면 WorkspaceRouteRule 로 프로젝트를 해석해 해당 프로젝트 우선으로 필터한다(W3).
   format=json → { markdown, counts }, 기본 → text/markdown. */
export async function GET(request: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const { workspaceId } = guard;
  const url = new URL(request.url);
  const fmt = url.searchParams.get("format");
  const cwd = url.searchParams.get("cwd");

  // cwd → 프로젝트 스코프 (라우트룰, 없으면 워크스페이스 전역)
  let projectId: string | null = null;
  let projectName: string | null = null;
  if (cwd) {
    const rules = await prisma.workspaceRouteRule.findMany({
      where: { workspaceId },
      select: { cwdPrefix: true, workspaceId: true, projectId: true, priority: true },
    });
    projectId = resolveRouteByCwd(cwd, rules)?.projectId ?? null;
    if (projectId) {
      const p = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
      projectName = p?.name ?? null;
      if (!p) projectId = null;
    }
  }

  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } });

  // 보드(첫 database) 열린 태스크
  const db = await prisma.page.findFirst({
    where: { kind: "database", workspaceId, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  const tasks: { title: string; status: string | null; due: string | null; assignee: string | null }[] = [];
  if (db) {
    const [props, rows] = await Promise.all([
      prisma.dbProperty.findMany({ where: { databasePageId: db.id }, orderBy: { position: "asc" } }),
      prisma.dbRow.findMany({ where: { databasePageId: db.id }, orderBy: { position: "asc" } }),
    ]);
    const titleProp = props.find((p) => p.type === "text") ?? props[0] ?? null;
    const statusProp = props.find((p) => p.type === "select" && /status|상태/i.test(p.name)) ?? props.find((p) => p.type === "select") ?? null;
    const dateProp = props.find((p) => p.type === "date") ?? null;
    const asgnProp = props.find((p) => p.type === "text" && /담당|assignee/i.test(p.name)) ?? null;
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
    prisma.page.findMany({ where: { kind: "doc", workspaceId, deletedAt: null, ...projFilter }, orderBy: { updatedAt: "desc" }, select: { title: true, updatedAt: true }, take: 50 }),
    prisma.decision.findMany({ where: { workspaceId, status: "accepted", ...projFilter }, orderBy: { decidedAt: "desc" }, select: { title: true, decision: true }, take: 30 }),
    prisma.risk.findMany({ where: { workspaceId, status: "open", ...projFilter }, orderBy: { createdAt: "desc" }, select: { title: true, severity: true }, take: 30 }),
    prisma.glossaryTerm.findMany({ where: { workspaceId }, orderBy: { term: "asc" }, select: { term: true, definition: true }, take: 100 }),
    // 레슨: 전역 + (cwd 매핑 시) 해당 프로젝트 — 팀 작업규칙은 항상 주입된다 (W3 mem-9)
    prisma.lesson.findMany({
      where: { workspaceId, ...(projectId ? { OR: [{ projectId: null }, { projectId }] } : {}) },
      orderBy: [{ projectId: "asc" }, { updatedAt: "desc" }],
      select: { title: true, body: true, projectId: true },
      take: 50,
    }),
  ]);

  const L: string[] = [];
  L.push(`# 워크스페이스: ${ws?.name ?? "TeamSpace"}${projectName ? ` · 프로젝트: ${projectName}` : ""}`);
  L.push(`_Claude 세션 공유 컨텍스트 (읽기 전용 스냅샷${projectName ? `, cwd→${projectName} 스코프` : ""})_`);
  L.push("");

  L.push(`## 팀 작업규칙·레슨 (${lessons.length}) — 반드시 따른다`);
  if (lessons.length === 0) L.push("- (없음)");
  for (const l of lessons) L.push(`- **${l.title}**${l.projectId ? "" : " [전역]"}: ${l.body}`);
  L.push("");

  L.push(`## 태스크 보드 — 열린 ${tasks.length}건`);
  if (tasks.length === 0) L.push("- (열린 태스크 없음)");
  for (const t of tasks) {
    const meta = [t.status, t.assignee, t.due ? `마감 ${t.due}` : null].filter(Boolean).join(" · ");
    L.push(`- ${t.title}${meta ? ` — ${meta}` : ""}`);
  }
  L.push("");

  L.push(`## 문서 (${docs.length})`);
  if (docs.length === 0) L.push("- (없음)");
  for (const d of docs) L.push(`- ${d.title}`);
  L.push("");

  L.push(`## 결정 — 승인됨 (${decisions.length})`);
  if (decisions.length === 0) L.push("- (없음)");
  for (const d of decisions) L.push(`- ${d.title}${d.decision ? `: ${d.decision}` : ""}`);
  L.push("");

  L.push(`## 리스크 — 열림 (${risks.length})`);
  if (risks.length === 0) L.push("- (없음)");
  for (const r of risks) L.push(`- [${r.severity}] ${r.title}`);
  L.push("");

  L.push(`## 용어집 (${glossary.length})`);
  if (glossary.length === 0) L.push("- (없음)");
  for (const g of glossary) L.push(`- **${g.term}**: ${g.definition ?? ""}`);
  L.push("");

  const markdown = L.join("\n");
  const counts = { lessons: lessons.length, tasks: tasks.length, docs: docs.length, decisions: decisions.length, risks: risks.length, glossary: glossary.length };

  if (fmt === "json") return NextResponse.json({ markdown, counts });
  return new NextResponse(markdown, { headers: { "content-type": "text/markdown; charset=utf-8" } });
}
