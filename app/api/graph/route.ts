import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { loadGraph } from "@/lib/graphLoad";
import { z } from "zod";
import { subgraph, projectSlice } from "@/lib/graphInsights";

export const runtime = "nodejs";

// GET /api/graph?types=doc,project&kinds=link,ref&project=<id>&hops=1|2
//   project: 그 프로젝트 소속 노드에서 hops(기본 1) 홉 안의 조각만(없는 id 면 빈 그래프). hops 가 1|2 가 아니면 400(빈 값 `hops=` 은 생략과 같다 — 기본 1). project 없이 hops 만 오면 무시.
//   → 지식 그래프 { nodes:[{id,title,type,href,projectId}], edges:[{from,to,kind,kinds,tag}] }
//   노드=문서·프로젝트·결정·레슨·태스크·리스크, 간선=link·ref·contains(추출)·mention·pair(추론)·related(모호).
//   기존 필드(id,title,from,to)는 그대로라 종전 호출자와 호환된다.
//   D3: 권한 필터는 loadGraph 에서 — 볼 수 있는 것만 들어온다.
export async function GET(request: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const sp = new URL(request.url).searchParams;
  const list = (k: string) => (sp.get(k) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const q = z.object({ project: z.string().optional(), hops: z.enum(["1", "2"]).optional() })
    .safeParse({ project: sp.get("project") || undefined, hops: sp.get("hops") || undefined });
  if (!q.success) return NextResponse.json({ error: "hops 는 1 또는 2" }, { status: 400 });
  const types = list("types");
  const kinds = list("kinds");

  let g = await loadGraph(guard);
  if (q.data.project) g = projectSlice(g, q.data.project, Number(q.data.hops ?? 1));
  if (types.length) g = subgraph(g, (n) => types.includes(n.type));
  if (kinds.length) g = { nodes: g.nodes, edges: g.edges.filter((e) => e.kinds.some((k) => kinds.includes(k))) };
  return NextResponse.json(g);
}
