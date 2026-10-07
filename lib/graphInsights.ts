/* 지식 그래프 위의 읽기 전용 계산 — 허브·군집·이웃·지식 지도. 순수 함수. */

import type { KGraph, GNode, EdgeKind, EdgeTag, NodeType } from "./knowledgeGraph";

export type Neighbor = {
  id: string; title: string; type: NodeType; href: string | null;
  kind: EdgeKind; tag: EdgeTag; direction: "out" | "in"; hop: number;
};

const byTitle = (a: GNode, b: GNode) => a.title.localeCompare(b.title, "ko");

export function degreeMap(g: KGraph): Map<string, number> {
  const d = new Map<string, number>();
  for (const e of g.edges) {
    d.set(e.from, (d.get(e.from) ?? 0) + 1);
    d.set(e.to, (d.get(e.to) ?? 0) + 1);
  }
  return d;
}

export function hubs(g: KGraph, n: number, types: NodeType[] = ["doc"]): { node: GNode; degree: number }[] {
  const d = degreeMap(g);
  return g.nodes
    .filter((x) => types.includes(x.type) && (d.get(x.id) ?? 0) > 0)
    .map((node) => ({ node, degree: d.get(node.id) ?? 0 }))
    .sort((a, b) => b.degree - a.degree || byTitle(a.node, b.node))
    .slice(0, n);
}

/** 라벨 전파. 프로젝트 노드와 그 contains 간선은 뺀다(프로젝트 묶음은 이미 아는 정보다). 결정적: id 순 순회, 동률은 작은 라벨. */
export function communities(g: KGraph, maxIter = 20): { members: GNode[]; rep: GNode }[] {
  // 문서 노드만 — 프로젝트·결정·레슨·태스크·리스크는 군집 구성원이 아니다(허브와 같은 기준)
  const nodes = g.nodes.filter((n) => n.type === "doc");
  const docIds = new Set(nodes.map((n) => n.id));
  const adj = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of g.edges) {
    if (!docIds.has(e.from) || !docIds.has(e.to)) continue;
    adj.get(e.from)?.push(e.to);
    adj.get(e.to)?.push(e.from);
  }
  const label = new Map(nodes.map((n) => [n.id, n.id]));
  const order = [...adj.keys()].sort();
  for (let it = 0; it < maxIter; it++) {
    let changed = false;
    for (const id of order) {
      const nb = adj.get(id)!;
      if (nb.length === 0) continue;
      const count = new Map<string, number>();
      for (const v of nb) count.set(label.get(v)!, (count.get(label.get(v)!) ?? 0) + 1);
      let best = label.get(id)!;
      let bestN = count.get(best) ?? 0;
      for (const [l, c] of [...count.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (c > bestN) { best = l; bestN = c; }
      }
      if (best !== label.get(id)) { label.set(id, best); changed = true; }
    }
    if (!changed) break;
  }
  const d = degreeMap(g);
  const groups = new Map<string, GNode[]>();
  for (const n of nodes) groups.set(label.get(n.id)!, [...(groups.get(label.get(n.id)!) ?? []), n]);
  return [...groups.values()]
    .filter((m) => m.length >= 2)
    .map((members) => {
      const sorted = [...members].sort((a, b) => (d.get(b.id) ?? 0) - (d.get(a.id) ?? 0) || byTitle(a, b));
      return { members: sorted, rep: sorted[0] };
    })
    .sort((a, b) => b.members.length - a.members.length || byTitle(a.rep, b.rep));
}

export function neighbors(g: KGraph, id: string, depth = 1): Neighbor[] {
  // NaN 은 Math.max/min 을 그대로 통과해 0홉(빈 결과)이 됐다 — 숫자가 아니면 1홉
  const maxHop = Number.isNaN(depth) ? 1 : Math.min(2, Math.max(1, Math.trunc(depth)));
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const out: Neighbor[] = [];
  const seen = new Set([id]);
  let frontier = [id];
  for (let hop = 1; hop <= maxHop; hop++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const e of g.edges) {
        const other = e.from === cur ? e.to : e.to === cur ? e.from : null;
        if (!other || seen.has(other)) continue;
        const n = byId.get(other);
        if (!n) continue;
        seen.add(other);
        next.push(other);
        out.push({ id: n.id, title: n.title, type: n.type, href: n.href, kind: e.kind, tag: e.tag, direction: e.from === cur ? "out" : "in", hop });
      }
    }
    frontier = next;
  }
  return out;
}

export function subgraph(g: KGraph, keep: (n: GNode) => boolean): KGraph {
  const nodes = g.nodes.filter(keep);
  const ids = new Set(nodes.map((n) => n.id));
  return { nodes, edges: g.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
}

/** LLM 연관 대상: 프로젝트 contains 말고는 간선이 없는 문서. */
export function weakDocs(g: KGraph): GNode[] {
  const projectIds = new Set(g.nodes.filter((n) => n.type === "project").map((n) => n.id));
  const strong = new Set<string>();
  for (const e of g.edges) {
    if (e.kind === "contains" && projectIds.has(e.from) && e.kinds.length === 1) continue;
    strong.add(e.from);
    strong.add(e.to);
  }
  return g.nodes.filter((n) => n.type === "doc" && !strong.has(n.id)).sort(byTitle);
}

const clip = (t: string, max = 40) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);

export function renderKnowledgeMap(g: KGraph, opts: { hubN: number; commN: number }): string[] {
  const L = ["## 지식 지도"];
  const h = hubs(g, opts.hubN);
  if (h.length === 0) return [...L, "- (연결된 문서 없음)", ""];
  L.push("허브:");
  for (const x of h) L.push(`- ${clip(x.node.title)} (연결 ${x.degree}) \`${x.node.id}\``);
  const c = communities(g).slice(0, opts.commN);
  if (c.length) {
    L.push("군집:");
    for (const x of c) {
      const others = x.members.slice(1, 2).map((m) => clip(m.title)).join(" · ");
      L.push(`- ${clip(x.rep.title)} 외 ${x.members.length - 1}건${others ? ` — ${others}` : ""}`);
    }
  }
  L.push("_이웃 탐색: MCP `graph_neighbors {id}` · 전체: `pnpm ws graph`_");
  L.push("");
  return L;
}
