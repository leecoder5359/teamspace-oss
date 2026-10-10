/* =====================================================================
   지식 그래프 로드 — DB 에서 읽고 **권한으로 거른 뒤** buildGraph 에 넘긴다.
   그래프 소비자(graph·neighbors·infer·search·context)는 전부 여기만 부른다:
   권한 필터가 한 곳에만 있어야 새는 경로가 생기지 않는다(D3).
     문서        visibleOnly
     프로젝트    projectAccess
     결정·레슨·리스크  projectId 가 있으면 projectAccess, 없으면 전역(보임)
     태스크      소속 보드 pageAccess
   캐시(D3 — 내용은 최대 60초 늦어도 되지만 권한은 즉시):
     1) 권한 색인은 매번 새로 계산(loadAccess, 수 ms).
     2) 원시 DB 행은 워크스페이스별로 60초 캐시(권한과 무관한 데이터).
     3) 권한으로 거른 입력의 지문(워크스페이스·원시 세대·보이는 id 들의 sha1)으로
        완성 그래프를 캐시 — 권한이 바뀌면 지문이 달라져 즉시 다시 만든다.
   새 related 간선(infer)은 invalidateGraphCache 로 즉시 반영.
   ===================================================================== */

import { createHash } from "node:crypto";
import { archivedPageIds } from "@/lib/pageArchive";
import { prisma } from "@/lib/prisma";
import { loadAccess, visibleOnly } from "@/lib/pageGuard";
import { pageAccess, projectAccess, type AccessIndex } from "@/lib/pageAccess";
import type { Ctx } from "@/lib/workspace";
import { buildGraph, type GraphInput, type KGraph } from "@/lib/knowledgeGraph";

export const GRAPH_CACHE_TTL_MS = 60_000;
const BUILT_CACHE_MAX = 200;

type Raw = Awaited<ReturnType<typeof loadRaw>>;
// 진행 중 Promise 도 담아 동시 요청이 DB 를 한 번만 읽게 한다. gen 은 다시 읽을 때마다 바뀐다.
const rawCache = new Map<string, { at: number; gen: number; raw: Promise<Raw> }>();
const builtCache = new Map<string, KGraph>(); // key = `${workspaceId}:${sha1}`
let genSeq = 0;

/** 캐시 비우기. workspaceId 를 주면 그 워크스페이스 항목만(원시·완성 둘 다). */
export function invalidateGraphCache(workspaceId?: string): void {
  if (workspaceId === undefined) {
    rawCache.clear();
    builtCache.clear();
    return;
  }
  rawCache.delete(workspaceId);
  dropBuilt(workspaceId);
}

function dropBuilt(workspaceId: string): void {
  for (const k of builtCache.keys()) if (k.startsWith(`${workspaceId}:`)) builtCache.delete(k);
}

/** 테스트 전용 — 캐시 항목 수. */
export function __graphCacheSizes(): { raw: number; built: number } {
  return { raw: rawCache.size, built: builtCache.size };
}

/** 호출자가 배열을 바꿔도 캐시가 오염되지 않게 얕은 복사로 내준다(소비자는 노드·간선 객체를 바꾸지 않는다). */
const copy = (g: KGraph): KGraph => ({ nodes: [...g.nodes], edges: [...g.edges] });

function getRaw(workspaceId: string): { gen: number; raw: Promise<Raw> } {
  const now = Date.now();
  const hit = rawCache.get(workspaceId);
  if (hit && now - hit.at < GRAPH_CACHE_TTL_MS) return hit;
  // 새 세대: 이 워크스페이스의 낡은 완성 캐시와 다른 워크스페이스의 만료된 원시 항목을 정리한다.
  dropBuilt(workspaceId);
  for (const [ws, e] of rawCache) {
    if (ws !== workspaceId && now - e.at >= GRAPH_CACHE_TTL_MS) {
      rawCache.delete(ws);
      dropBuilt(ws);
    }
  }
  const entry = { at: now, gen: ++genSeq, raw: loadRaw(workspaceId) };
  rawCache.set(workspaceId, entry);
  entry.raw.catch(() => {
    if (rawCache.get(workspaceId) === entry) rawCache.delete(workspaceId); // 실패는 캐시하지 않는다
  });
  return entry;
}

async function loadRaw(workspaceId: string) {
  const [allPages, projects, decisions, lessons, risks, rows, titleProps, stored] = await Promise.all([
    // 보관은 보드(database)에도 걸리므로 문서와 보드를 한 번에 읽는다(보관 집합용 id·parentId·archivedAt·kind).
    prisma.page.findMany({
      where: { workspaceId, kind: { in: ["doc", "database"] }, deletedAt: null },
      select: { id: true, title: true, markdown: true, parentId: true, projectId: true, archivedAt: true, kind: true },
    }),
    prisma.project.findMany({ where: { workspaceId }, select: { id: true, name: true } }),
    prisma.decision.findMany({ where: { workspaceId }, select: { id: true, title: true, context: true, decision: true, projectId: true } }),
    prisma.lesson.findMany({ where: { workspaceId }, select: { id: true, title: true, body: true, projectId: true } }),
    prisma.risk.findMany({ where: { workspaceId }, select: { id: true, title: true, description: true, projectId: true } }),
    prisma.dbRow.findMany({
      where: { database: { workspaceId, deletedAt: null } },
      select: { id: true, databasePageId: true, contentPageId: true, props: true },
    }),
    prisma.dbProperty.findMany({
      where: { database: { workspaceId }, type: "text" },
      orderBy: { position: "asc" },
      select: { id: true, databasePageId: true },
    }),
    prisma.graphEdge.findMany({ where: { workspaceId, kind: "related" }, select: { fromId: true, toId: true, kind: true } }),
  ]);
  // 보관(F2)은 조상 규칙까지 적용한다. 보드(database)도 보관되므로 문서뿐 아니라 보드까지 넣어 집합을 만든다.
  // 보관 보드 밑의 문서와 보관 보드의 행(및 행 본문 문서)도 뺀다. 프로젝트는 보관돼도 유지한다.
  const archived = archivedPageIds(allPages);
  const pages = allPages.filter((p) => p.kind !== "database");
  const activeRows = rows.filter((r) => !archived.has(r.databasePageId) && !(r.contentPageId && archived.has(r.contentPageId)));
  const droppedBodies = new Set(rows.filter((r) => r.contentPageId && archived.has(r.databasePageId)).map((r) => r.contentPageId as string));
  const activePages = pages.filter((p) => !archived.has(p.id) && !droppedBodies.has(p.id)).map((p) => ({ id: p.id, title: p.title, markdown: p.markdown, parentId: p.parentId, projectId: p.projectId }));
  return { pages: activePages, projects, decisions, lessons, risks, rows: activeRows, titleProps, stored };
}

/** 권한으로 거른 입력의 지문 — 보이는 노드 집합과 권한에 따라 지워지는 연결(projectId·contentPageId)을 담는다. */
function fingerprint(workspaceId: string, gen: number, input: GraphInput): string {
  const ids = [
    ...input.docs.map((d) => `d${d.id}>${d.projectId ?? ""}`),
    ...input.projects.map((p) => `p${p.id}`),
    ...input.objects.map((o) => `o${o.id}>${o.type === "task" ? (o.contentPageId ?? "") : ""}`),
  ].sort();
  return `${workspaceId}:${createHash("sha1").update(`${gen}\n${ids.join("\n")}`).digest("hex")}`;
}

export async function loadGraph(ctx: Ctx, access?: AccessIndex): Promise<KGraph> {
  const { workspaceId } = ctx;
  const idx = access ?? (await loadAccess(ctx));
  if (idx.ceiling === "none") return { nodes: [], edges: [] };
  const { gen, raw } = getRaw(workspaceId);
  const input = filterInput(idx, await raw);
  const key = fingerprint(workspaceId, gen, input);
  let g = builtCache.get(key);
  if (!g) {
    g = buildGraph(input);
    builtCache.set(key, g);
    while (builtCache.size > BUILT_CACHE_MAX) builtCache.delete(builtCache.keys().next().value!);
  }
  return copy(g);
}

function filterInput(idx: AccessIndex, { pages, projects, decisions, lessons, risks, rows, titleProps, stored }: Raw): GraphInput {
  const projOk = (pid: string | null) => !pid || projectAccess(idx, pid) !== "none";
  const titlePropOf = new Map<string, string>();
  for (const p of titleProps) if (!titlePropOf.has(p.databasePageId)) titlePropOf.set(p.databasePageId, p.id);

  const input: GraphInput = {
    docs: visibleOnly(idx, pages).map((p) => ({ ...p, projectId: p.projectId && projectAccess(idx, p.projectId) !== "none" ? p.projectId : null })),
    projects: projects.filter((p) => projectAccess(idx, p.id) !== "none"),
    objects: [
      ...decisions.filter((d) => projOk(d.projectId)).map((d) => ({
        id: d.id, type: "decision" as const, title: d.title, text: [d.context, d.decision].filter(Boolean).join("\n"), projectId: d.projectId,
      })),
      ...lessons.filter((l) => projOk(l.projectId)).map((l) => ({ id: l.id, type: "lesson" as const, title: l.title, text: l.body, projectId: l.projectId })),
      ...risks.filter((r) => projOk(r.projectId)).map((r) => ({ id: r.id, type: "risk" as const, title: r.title, text: r.description ?? "", projectId: r.projectId })),
      ...rows.filter((r) => pageAccess(idx, r.databasePageId) !== "none").map((r) => {
        const props = (r.props ?? {}) as Record<string, unknown>;
        const tp = titlePropOf.get(r.databasePageId);
        const title = (tp && typeof props[tp] === "string" ? (props[tp] as string) : "") || "(제목 없음)";
        return { id: r.id, type: "task" as const, title, text: JSON.stringify(props), projectId: null, boardId: r.databasePageId, contentPageId: r.contentPageId && pageAccess(idx, r.contentPageId) !== "none" ? r.contentPageId : null };
      }),
    ],
    stored: stored.map((s) => ({ fromId: s.fromId, toId: s.toId, kind: "related" as const })),
  };
  // 보이지 않는 문서를 가리키는 contentPageId 는 buildGraph 가 '노드 없음'으로 버린다.
  return input;
}
