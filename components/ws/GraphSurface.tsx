"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./icons";
import { graphToCypher } from "@/lib/wikilink";

function download(name: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/* 그래프 뷰 — 문서 간 위키링크 그래프. /api/graph. 원형 레이아웃 SVG. */

type Node = { id: string; title: string };
type Edge = { from: string; to: string };

const xmlEsc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]!));
function graphToGraphML(g: { nodes: Node[]; edges: Edge[] }): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    '  <key id="label" for="node" attr.name="label" attr.type="string"/>',
    '  <graph edgedefault="directed">',
  ];
  for (const n of g.nodes) lines.push(`    <node id="${xmlEsc(n.id)}"><data key="label">${xmlEsc(n.title)}</data></node>`);
  g.edges.forEach((e, i) => lines.push(`    <edge id="e${i}" source="${xmlEsc(e.from)}" target="${xmlEsc(e.to)}"/>`));
  lines.push("  </graph>", "</graphml>");
  return lines.join("\n");
}

const W = 820;
const H = 560;
const CX = W / 2;
const CY = H / 2;

export default function GraphSurface() {
  const router = useRouter();
  const [data, setData] = useState<{ nodes: Node[]; edges: Edge[] } | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/graph", { cache: "no-store" });
      setData((await res.json()) as { nodes: Node[]; edges: Edge[] });
    })();
  }, []);

  // 원형 레이아웃(결정적)
  const pos = useMemo(() => {
    const m = new Map<string, { x: number; y: number }>();
    if (!data) return m;
    const n = data.nodes.length;
    const R = Math.min(CX, CY) - 90;
    data.nodes.forEach((nd, i) => {
      const a = (2 * Math.PI * i) / Math.max(1, n) - Math.PI / 2;
      m.set(nd.id, { x: CX + R * Math.cos(a), y: CY + R * Math.sin(a) });
    });
    return m;
  }, [data]);

  if (data === null) return <div className="ws-db" style={{ padding: 40 }} />;

  const degree = new Map<string, number>();
  for (const e of data.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const isAdj = (id: string) =>
    hover != null && (hover === id || data.edges.some((e) => (e.from === hover && e.to === id) || (e.to === hover && e.from === id)));

  return (
    <div className="ws-db">
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h1 className="ws-db-title" style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
          <Icon name="link" /> 그래프 뷰
        </h1>
        <span style={{ flex: 1 }} />
        <button className="ws-btn-soft" disabled={data.nodes.length === 0} onClick={() => download("wiki-graph.json", "application/json", JSON.stringify(data, null, 2))}>JSON</button>
        <button className="ws-btn-soft" disabled={data.nodes.length === 0} onClick={() => download("wiki-graph.cypher", "text/plain", graphToCypher(data))}>Cypher</button>
        <button className="ws-btn-soft" disabled={data.nodes.length === 0} onClick={() => download("wiki-graph.graphml", "application/xml", graphToGraphML(data))}>GraphML</button>
      </div>
      <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 4 }}>
        문서 간 `[[위키링크]]` 연결 그래프 · 노드 {data.nodes.length} · 간선 {data.edges.length} · 노드를 클릭하면 문서로 이동.
      </p>

      {data.nodes.length === 0 ? (
        <div className="ws-empty-hint" style={{ marginTop: 24 }}>문서가 없습니다.</div>
      ) : (
        <div style={{ marginTop: 12, border: "1px solid var(--border-subtle)", borderRadius: 14, background: "var(--surface-card)", overflow: "hidden" }}>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
            <defs>
              <marker id="wl-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="var(--border-default)" />
              </marker>
            </defs>
            {/* 간선 */}
            {data.edges.map((e, i) => {
              const a = pos.get(e.from);
              const b = pos.get(e.to);
              if (!a || !b) return null;
              const on = hover != null && (e.from === hover || e.to === hover);
              return (
                <line
                  key={i}
                  x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={on ? "var(--color-primary)" : "var(--border-default)"}
                  strokeWidth={on ? 2 : 1}
                  markerEnd="url(#wl-arrow)"
                  opacity={hover != null && !on ? 0.25 : 1}
                />
              );
            })}
            {/* 노드 */}
            {data.nodes.map((nd) => {
              const p = pos.get(nd.id)!;
              const deg = degree.get(nd.id) ?? 0;
              const r = 6 + Math.min(8, deg * 2);
              const active = hover == null || isAdj(nd.id);
              const right = p.x >= CX;
              return (
                <g
                  key={nd.id}
                  style={{ cursor: "pointer" }}
                  opacity={active ? 1 : 0.3}
                  onMouseEnter={() => setHover(nd.id)}
                  onMouseLeave={() => setHover(null)}
                  onClick={() => router.push(`/p/${nd.id}`)}
                >
                  <circle cx={p.x} cy={p.y} r={r} fill={hover === nd.id ? "var(--color-primary)" : "var(--color-primary-weak)"} stroke="var(--color-primary)" strokeWidth={1.5} />
                  <text
                    x={right ? p.x + r + 5 : p.x - r - 5}
                    y={p.y + 4}
                    textAnchor={right ? "start" : "end"}
                    style={{ fontSize: 12, fontWeight: 600, fill: "var(--text-strong)" }}
                  >
                    {nd.title.length > 22 ? nd.title.slice(0, 22) + "…" : nd.title}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}
    </div>
  );
}
