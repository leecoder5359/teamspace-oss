/* 위키링크 파싱/백링크 — file-first 문서의 [[제목]] 양방향 링크. 순수 함수. */

export const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/** [[제목]] / [[제목|표시]] 에서 제목부만 추출. 트림·중복제거·순서유지. */
export function extractWikiTitles(md: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of md.matchAll(WIKILINK_RE)) {
    const raw = m[1].split("|")[0].trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

export function normalizeTitle(t: string): string {
  return t.trim().toLowerCase();
}

export type PageLite = { id: string; title: string; markdown: string | null };

/**
 * 타깃 페이지 id → 그 페이지를 가리키는 소스 페이지들.
 * 제목 매칭은 대소문자 무시. 자기참조 제외. 소스는 id로 중복제거.
 */
export function computeBacklinks(pages: PageLite[]): Record<string, { id: string; title: string }[]> {
  const idByTitle = new Map<string, string>();
  for (const p of pages) {
    const key = normalizeTitle(p.title);
    if (!idByTitle.has(key)) idByTitle.set(key, p.id);
  }

  const back: Record<string, { id: string; title: string }[]> = {};
  const seen: Record<string, Set<string>> = {};
  for (const p of pages) {
    const titles = extractWikiTitles(p.markdown ?? "");
    for (const t of titles) {
      const targetId = idByTitle.get(normalizeTitle(t));
      if (!targetId || targetId === p.id) continue;
      (back[targetId] ??= []);
      (seen[targetId] ??= new Set());
      if (seen[targetId].has(p.id)) continue;
      seen[targetId].add(p.id);
      back[targetId].push({ id: p.id, title: p.title });
    }
  }
  return back;
}

/** 위키 그래프: 노드=문서, 간선=해결된 [[링크]](미해결·자기 제외, 중복제거). */
export function computeGraph(pages: PageLite[]): {
  nodes: { id: string; title: string }[];
  edges: { from: string; to: string }[];
} {
  const idByTitle = new Map<string, string>();
  for (const p of pages) {
    const key = normalizeTitle(p.title);
    if (!idByTitle.has(key)) idByTitle.set(key, p.id);
  }
  const edges: { from: string; to: string }[] = [];
  const seen = new Set<string>();
  for (const p of pages) {
    for (const t of extractWikiTitles(p.markdown ?? "")) {
      const to = idByTitle.get(normalizeTitle(t));
      if (!to || to === p.id) continue;
      const key = `${p.id}>${to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: p.id, to });
    }
  }
  return { nodes: pages.map((p) => ({ id: p.id, title: p.title })), edges };
}

/** wiki-lint: 깨진 링크(해결 안 되는 [[대상]]) + 고아 페이지(인/아웃 링크 없음). */
export function computeLint(pages: PageLite[]): {
  broken: { sourceId: string; sourceTitle: string; target: string }[];
  orphans: { id: string; title: string }[];
} {
  const idByTitle = new Map<string, string>();
  for (const p of pages) {
    const key = normalizeTitle(p.title);
    if (!idByTitle.has(key)) idByTitle.set(key, p.id);
  }

  const broken: { sourceId: string; sourceTitle: string; target: string }[] = [];
  for (const p of pages) {
    for (const t of extractWikiTitles(p.markdown ?? "")) {
      if (!idByTitle.has(normalizeTitle(t))) {
        broken.push({ sourceId: p.id, sourceTitle: p.title, target: t });
      }
    }
  }

  const connected = new Set<string>();
  for (const e of computeGraph(pages).edges) {
    connected.add(e.from);
    connected.add(e.to);
  }
  const orphans = pages.filter((p) => !connected.has(p.id)).map((p) => ({ id: p.id, title: p.title }));

  return { broken, orphans };
}

/** 위키 그래프 → Cypher(Neo4j) 스크립트. */
export function graphToCypher(graph: {
  nodes: { id: string; title: string }[];
  edges: { from: string; to: string }[];
}): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const lines: string[] = [];
  for (const n of graph.nodes) {
    lines.push(`CREATE (\`${n.id}\`:Doc {id:'${esc(n.id)}', title:'${esc(n.title)}'});`);
  }
  for (const e of graph.edges) {
    lines.push(`MATCH (a:Doc {id:'${esc(e.from)}'}), (b:Doc {id:'${esc(e.to)}'}) CREATE (a)-[:LINKS_TO]->(b);`);
  }
  return lines.join("\n");
}
