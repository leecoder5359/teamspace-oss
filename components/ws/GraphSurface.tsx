"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./icons";
import { graphToCypher } from "@/lib/wikilink";
import { isZoomedIn, selectLabelIds, truncateLabel } from "@/lib/graphLabels";
import { adjacency, computeLayout, degrees, withinDepth, type Point } from "@/lib/graphLayout";

function download(name: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/* =====================================================================
   그래프 뷰 — 문서 간 위키링크 그래프. /api/graph.

   종전엔 노드를 배열 순서대로 원 둘레에 놓아 **군집이 보이지 않았다**.
   이제 힘기반 레이아웃(lib/graphLayout, 결정적)으로 배치하고 줌·팬·드래그·
   검색·깊이 필터를 붙인다.
   ===================================================================== */

type Node = { id: string; title: string; type?: string; href?: string | null };
type Edge = { from: string; to: string; kind?: string; kinds?: string[]; tag?: string };
const NODE_TYPES: [string, string][] = [["doc,project", "문서+프로젝트"], ["doc", "문서만"], ["", "전체"]];
const EDGE_KINDS: [string, string][] = [["", "모든 관계"], ["link,ref,contains", "명시(추출)"], ["mention,pair", "언급·짝(추론)"], ["related", "AI 연관(모호)"]];

const xmlEsc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]!));
function graphToGraphML(g: { nodes: Node[]; edges: Edge[] }): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    '  <key id="label" for="node" attr.name="label" attr.type="string"/>',
    '  <key id="type" for="node" attr.name="type" attr.type="string"/>',
    '  <key id="kind" for="edge" attr.name="kind" attr.type="string"/>',
    '  <key id="tag" for="edge" attr.name="tag" attr.type="string"/>',
    '  <graph edgedefault="directed">',
  ];
  for (const n of g.nodes) lines.push(`    <node id="${xmlEsc(n.id)}"><data key="label">${xmlEsc(n.title)}</data><data key="type">${xmlEsc(n.type ?? "")}</data></node>`);
  g.edges.forEach((e, i) => lines.push(`    <edge id="e${i}" source="${xmlEsc(e.from)}" target="${xmlEsc(e.to)}"><data key="kind">${xmlEsc(e.kind ?? "")}</data><data key="tag">${xmlEsc(e.tag ?? "")}</data></edge>`));
  lines.push("  </graph>", "</graphml>");
  return lines.join("\n");
}

const primary: CSSProperties = { padding: "9px 16px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: "pointer", border: "1px solid transparent", background: "var(--color-primary)", color: "#fff" };

const W = 1200;
const H = 720;
type Box = { x: number; y: number; w: number; h: number };
const FULL: Box = { x: 0, y: 0, w: W, h: H };

export default function GraphSurface() {
  const router = useRouter();
  const [data, setData] = useState<{ nodes: Node[]; edges: Edge[] } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [depth, setDepth] = useState(0); // 0 = 전체
  const [query, setQuery] = useState("");
  const [types, setTypes] = useState("doc,project");
  const [kinds, setKinds] = useState("");
  const [project, setProject] = useState("");
  const [projects, setProjects] = useState<{ id: string; name: string; archivedAt: string | null }[]>([]);
  const [box, setBox] = useState<Box>(FULL);
  /** 사용자가 끌어다 놓은 노드 — 레이아웃 결과를 덮어쓴다 */
  const [pinned, setPinned] = useState<Map<string, Point>>(new Map());
  // 커서 모양에 쓰므로 ref 가 아니라 state — ref 는 렌더 중에 읽을 수 없다
  const [panning, setPanning] = useState(false);
  const [creating, setCreating] = useState(false);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragNode = useRef<string | null>(null);
  const panFrom = useRef<{ x: number; y: number; box: Box } | null>(null);

  useEffect(() => {
    let cancelled = false; // 느린 이전 응답이 최신 응답을 덮어쓰지 않게
    void (async () => {
      const q = new URLSearchParams();
      if (types) q.set("types", types);
      if (kinds) q.set("kinds", kinds);
      if (project) q.set("project", project);
      try {
        const res = await fetch(`/api/graph${q.size ? `?${q}` : ""}`, { cache: "no-store" });
        if (!res.ok) {
          if (cancelled) return;
          console.warn(`[graph] /api/graph ${res.status} — 이전 데이터를 유지합니다`);
          return;
        }
        const json = (await res.json()) as { nodes: Node[]; edges: Edge[] };
        if (!cancelled) setData(json);
      } catch (err) {
        if (cancelled) return;
        console.warn("[graph] /api/graph 요청 실패", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [types, kinds, project]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // 보관 포함으로 받아 이름 라벨을 유지하고, 필터 선택지는 활성 + 지금 선택한 것만
        const res = await fetch("/api/projects?archived=all", { cache: "no-store" });
        if (!res.ok) return;
        const j = (await res.json()) as { projects?: { id: string; name: string; archivedAt?: string | null }[] };
        if (!cancelled && Array.isArray(j.projects)) setProjects(j.projects.map((p) => ({ id: p.id, name: p.name, archivedAt: p.archivedAt ?? null })));
      } catch { /* 선택지가 없을 뿐 — 전체 보기는 그대로 */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const go = (nd: Node) => {
    const href = nd.href === undefined ? `/p/${nd.id}` : nd.href;
    if (href) router.push(href);
  };

  const layout = useMemo(() => (data ? computeLayout(data.nodes, data.edges, { width: W, height: H }) : new Map<string, Point>()), [data]);
  const deg = useMemo(() => (data ? degrees(data.nodes, data.edges) : new Map<string, number>()), [data]);
  const adj = useMemo(() => (data ? adjacency(data.edges) : new Map<string, Set<string>>()), [data]);

  const posOf = useCallback((id: string): Point | undefined => pinned.get(id) ?? layout.get(id), [pinned, layout]);

  /** 깊이 필터 대상 — focus 가 있을 때만 적용 */
  const visible = useMemo(() => {
    if (!data) return null;
    if (!focus || depth === 0) return null; // null = 전부 보임
    return withinDepth(adj, focus, depth);
  }, [data, focus, depth, adj]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !data) return null;
    return new Set(data.nodes.filter((n) => n.title.toLowerCase().includes(q)).map((n) => n.id));
  }, [query, data]);

  /** 라벨을 그릴 노드 — 상위 차수·기준·깊이 범위·검색 적중, 충분히 확대했으면 전부. 호버는 렌더에서 더한다. */
  const zoomedIn = isZoomedIn(box.w, W);
  const labelIds = useMemo(
    () => selectLabelIds({ nodes: data?.nodes ?? [], deg, focus, visible, matches, zoomedIn }),
    [data, deg, focus, visible, matches, zoomedIn],
  );

  /* ── 화면 좌표 → SVG 좌표 ── */
  const toSvg = useCallback(
    (clientX: number, clientY: number): Point => {
      const r = svgRef.current?.getBoundingClientRect();
      if (!r) return { x: 0, y: 0 };
      return { x: box.x + ((clientX - r.left) / r.width) * box.w, y: box.y + ((clientY - r.top) / r.height) * box.h };
    },
    [box],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent<SVGSVGElement>) => {
      e.preventDefault();
      const p = toSvg(e.clientX, e.clientY);
      const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      const w = Math.min(W * 3, Math.max(W * 0.15, box.w * k));
      const h = w * (H / W);
      // 커서 아래 지점이 고정되도록 원점을 보정한다
      setBox({ x: p.x - ((p.x - box.x) * w) / box.w, y: p.y - ((p.y - box.y) * h) / box.h, w, h });
    },
    [box, toSvg],
  );

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (dragNode.current) return;
    panFrom.current = { x: e.clientX, y: e.clientY, box };
    setPanning(true);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (dragNode.current) {
      const p = toSvg(e.clientX, e.clientY);
      setPinned((prev) => new Map(prev).set(dragNode.current!, p));
      return;
    }
    const from = panFrom.current;
    if (!from) return;
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return;
    const dx = ((e.clientX - from.x) / r.width) * from.box.w;
    const dy = ((e.clientY - from.y) / r.height) * from.box.h;
    setBox({ ...from.box, x: from.box.x - dx, y: from.box.y - dy });
  };

  /** 빈 그래프의 첫 액션 — 문서 목록의 '새 문서'와 같은 경로로 만들고 바로 연다. */
  const createDoc = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Untitled" }),
      });
      if (!res.ok) return;
      const { page } = (await res.json()) as { page: { id: string } };
      window.dispatchEvent(new Event("pages:changed"));
      router.push(`/p/${page.id}`);
    } finally {
      setCreating(false);
    }
  };

  const endDrag = () => {
    dragNode.current = null;
    panFrom.current = null;
    setPanning(false);
  };

  if (data === null) return <div className="ws-db" style={{ padding: 40 }} />;

  const empty = data.nodes.length === 0;
  const filtered = types !== "doc,project" || kinds !== "" || project !== "";
  const dim = (id: string) => {
    if (visible && !visible.has(id)) return 0.06;
    if (matches && !matches.has(id)) return 0.15;
    if (hover && !(hover === id || adj.get(hover)?.has(id))) return 0.22;
    return 1;
  };

  return (
    <div className="ws-db">
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h1 className="ws-db-title" style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
          <Icon name="link" /> 그래프 뷰
        </h1>
        <span style={{ flex: 1 }} />
        <input
          className="ws-db-filter"
          placeholder="문서 찾기"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ minWidth: 150 }}
          aria-label="문서 찾기"
        />
        <select
          className="ws-db-filter"
          value={depth}
          onChange={(e) => setDepth(Number(e.target.value))}
          aria-label="이웃 깊이"
          title="선택한 문서에서 몇 홉까지 보일지"
        >
          <option value={0}>전체</option>
          <option value={1}>이웃 1홉</option>
          <option value={2}>이웃 2홉</option>
          <option value={3}>이웃 3홉</option>
        </select>
        <select className="ws-db-filter" value={project} onChange={(e) => { setProject(e.target.value); setFocus(null); }} aria-label="프로젝트">
          <option value="">전체 프로젝트</option>
          {projects.filter((p) => !p.archivedAt || p.id === project).map((p) => <option key={p.id} value={p.id}>{p.archivedAt ? `${p.name} (보관)` : p.name}</option>)}
        </select>
        <select className="ws-db-filter" value={types} onChange={(e) => { setTypes(e.target.value); setFocus(null); }} aria-label="노드 종류">
          {NODE_TYPES.map(([v, l]) => <option key={l} value={v}>{l}</option>)}
        </select>
        <select className="ws-db-filter" value={kinds} onChange={(e) => { setKinds(e.target.value); setFocus(null); }} aria-label="관계 종류">
          {EDGE_KINDS.map(([v, l]) => <option key={l} value={v}>{l}</option>)}
        </select>
        <button className="ws-btn-soft" onClick={() => { setBox(FULL); setPinned(new Map()); setFocus(null); }}>
          초기화
        </button>
        <button className="ws-btn-soft" disabled={empty} onClick={() => download("wiki-graph.json", "application/json", JSON.stringify(data, null, 2))}>JSON</button>
        <button className="ws-btn-soft" disabled={empty} onClick={() => download("wiki-graph.cypher", "text/plain", graphToCypher(data))}>Cypher</button>
        <button className="ws-btn-soft" disabled={empty} onClick={() => download("wiki-graph.graphml", "application/xml", graphToGraphML(data))}>GraphML</button>
      </div>

      <p style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 4 }}>
        노드 {data.nodes.length} · 간선 {data.edges.length} · 휠=확대 · 배경 끌기=이동 · 노드 끌기=고정 · 클릭=기준 선택 · 더블클릭(⌥/⌘-클릭)=문서 열기
        {focus && <> · 기준 <b style={{ color: "var(--color-primary)" }}>{data.nodes.find((n) => n.id === focus)?.title}</b></>}
      </p>

      {empty ? (
        <div className="ws-docs-empty" style={{ marginTop: 24 }}>
          <span style={{ color: "var(--text-muted)" }}><Icon name="link" size={32} /></span>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text-strong)", marginTop: 14 }}>{filtered ? "이 필터에 맞는 노드가 없어요" : "그래프에 그릴 문서가 없어요"}</div>
          {!filtered && (
            <>
              <div style={{ fontSize: 13, color: "var(--text-sub)", marginTop: 6 }}>
                여기는 문서끼리의 연결만 그립니다. 문서를 만들고 본문에서 <code>[[문서 제목]]</code> 으로 다른 문서를 가리키면 그 관계가 선으로 나타나요.
              </div>
              <div style={{ marginTop: 14 }}>
                <button style={primary} disabled={creating} onClick={createDoc}>{creating ? "만드는 중…" : "문서 만들기"}</button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 12, border: "1px solid var(--border-subtle)", borderRadius: 14, background: "var(--surface-card)", overflow: "hidden" }}>
          <svg
            ref={svgRef}
            viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
            style={{ width: "100%", height: "auto", display: "block", touchAction: "none", cursor: panning ? "grabbing" : "grab" }}
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerLeave={endDrag}
          >
            <defs>
              <marker id="wl-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="var(--border-default)" />
              </marker>
            </defs>

            {data.edges.map((e, i) => {
              const a = posOf(e.from);
              const b = posOf(e.to);
              if (!a || !b) return null;
              const on = hover != null && (e.from === hover || e.to === hover);
              const op = Math.min(dim(e.from), dim(e.to));
              return (
                <line
                  key={i}
                  x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={on ? "var(--color-primary)" : "var(--border-default)"}
                  strokeWidth={on ? 2 : 1}
                  strokeDasharray={e.tag && e.tag !== "추출" ? "4 3" : undefined}
                  markerEnd="url(#wl-arrow)"
                  opacity={on ? 1 : op * 0.7}
                />
              );
            })}

            {data.nodes.map((nd) => {
              const p = posOf(nd.id);
              if (!p) return null;
              const d = deg.get(nd.id) ?? 0;
              const r = 6 + Math.min(10, d * 1.6);
              const isFocus = focus === nd.id;
              const isHit = matches?.has(nd.id) ?? false;
              return (
                <g
                  key={nd.id}
                  opacity={dim(nd.id)}
                  style={{ cursor: "pointer" }}
                  onMouseEnter={() => setHover(nd.id)}
                  onMouseLeave={() => setHover(null)}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    dragNode.current = nd.id;
                    (e.target as Element).setPointerCapture?.(e.pointerId);
                  }}
                  onClick={(e) => {
                    // 끌어서 옮긴 직후엔 이동하지 않는다
                    if (pinned.has(nd.id) && e.detail === 1 && dragNode.current === nd.id) return;
                    if (e.altKey || e.metaKey) go(nd);
                    else setFocus(isFocus ? null : nd.id);
                  }}
                  onDoubleClick={() => go(nd)}
                >
                  <circle
                    cx={p.x} cy={p.y} r={r}
                    fill={isFocus || hover === nd.id ? "var(--color-primary)" : isHit ? "var(--color-primary-weak)" : "var(--surface-sunken)"}
                    stroke="var(--color-primary)"
                    strokeWidth={isFocus ? 2.5 : 1.5}
                  />
                  <title>{nd.title}</title>
                  {(labelIds.has(nd.id) || hover === nd.id) && (
                    <text
                      x={p.x + r + 5}
                      y={p.y + 4}
                      style={{ fontSize: 12, fontWeight: 600, fill: "var(--text-strong)", pointerEvents: "none" }}
                    >
                      {truncateLabel(nd.title)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
      )}
      <p style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 6 }}>
        노드를 클릭하면 그 문서를 기준으로 삼는다(깊이 필터가 여기에 걸린다). 문서를 열려면 더블클릭(또는 ⌥/⌘-클릭) — 링크가 없는 노드는 열리지 않는다.
      </p>
    </div>
  );
}
