import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { loadGraph } from "@/lib/graphLoad";
import { subgraph } from "@/lib/graphInsights";

export const runtime = "nodejs";

// GET /api/graph?types=doc,project&kinds=link,ref
//   → 지식 그래프 { nodes:[{id,title,type,href,projectId}], edges:[{from,to,kind,kinds,tag}] }
//   노드=문서·프로젝트·결정·레슨·태스크·리스크, 간선=link·ref·contains(추출)·mention·pair(추론)·related(모호).
//   기존 필드(id,title,from,to)는 그대로라 종전 호출자와 호환된다.
//   D3: 권한 필터는 loadGraph 에서 — 볼 수 있는 것만 들어온다.
export async function GET(request: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const sp = new URL(request.url).searchParams;
  const list = (k: string) => (sp.get(k) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const types = list("types");
  const kinds = list("kinds");

  let g = await loadGraph(guard);
  if (types.length) g = subgraph(g, (n) => types.includes(n.type));
  if (kinds.length) g = { nodes: g.nodes, edges: g.edges.filter((e) => e.kinds.some((k) => kinds.includes(k))) };
  return NextResponse.json(g);
}
