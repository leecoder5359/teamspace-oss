import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { loadGraph } from "@/lib/graphLoad";
import { neighbors } from "@/lib/graphInsights";

export const runtime = "nodejs";

// GET /api/graph/neighbors?id=<노드 id>&depth=1|2
//   → { node, neighbors:[{id,title,type,href,kind,tag,direction,hop}] }
//   Graphify 의 `query` 에 해당 — 원문을 다 읽지 않고 관계부터 본다.
//   못 보는 노드는 그래프에 없으므로 404(존재 여부를 흘리지 않는다, D3).
export async function GET(request: Request) {
  const guard = await requireCtx();
  if ("err" in guard) return guard.err;
  const sp = new URL(request.url).searchParams;
  const id = (sp.get("id") ?? "").trim();
  if (!id) return NextResponse.json({ error: "id가 필요합니다." }, { status: 400 });
  const depth = Number(sp.get("depth") ?? 1) || 1;

  const g = await loadGraph(guard);
  const node = g.nodes.find((n) => n.id === id);
  if (!node) return NextResponse.json({ error: "노드를 찾을 수 없습니다." }, { status: 404 });
  return NextResponse.json({ node, neighbors: neighbors(g, id, depth) });
}
