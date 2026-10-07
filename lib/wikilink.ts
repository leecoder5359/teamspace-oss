/* 위키링크 파싱/백링크 — file-first 문서의 [[제목]] 양방향 링크. 순수 함수. */

import { extractFrontmatter } from "./md/parse";
import { scanWikilinks } from "./md/wikilinkSyntax";

/** [[제목]] / [[제목|표시]] 에서 제목부만 추출. 트림·중복제거·순서유지. */
export function extractWikiTitles(md: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of scanWikilinks(md)) {
    const raw = m.inner.split("|")[0].trim();
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
 * 제목·별칭 → 페이지 id 색인.
 *
 * 별칭이 필요한 이유: 같은 대상을 "로요"/"LOYO"/"단골노트" 로 부르면 종전엔
 * 각각 다른(대개 미해결) 링크가 됐다. 프론트매터 `aliases` 를 색인에 함께
 * 넣어 한 노드로 수렴시킨다.
 *
 * 충돌 규칙: 실제 제목이 항상 이긴다. 별칭끼리 겹치면 먼저 등록된 쪽을 둔다
 * (조용히 덮어쓰면 어느 문서로 가는지 예측할 수 없어진다).
 */
export function buildTitleIndex(pages: PageLite[]): Map<string, string> {
  const idByTitle = new Map<string, string>();
  for (const p of pages) {
    const key = normalizeTitle(p.title);
    if (!idByTitle.has(key)) idByTitle.set(key, p.id);
  }
  for (const p of pages) {
    const fm = extractFrontmatter(p.markdown ?? "").frontmatter;
    const raw = fm?.aliases;
    if (!raw) continue;
    const aliases = Array.isArray(raw) ? raw : [raw];
    for (const a of aliases) {
      const key = normalizeTitle(String(a));
      if (key && !idByTitle.has(key)) idByTitle.set(key, p.id);
    }
  }
  return idByTitle;
}

/**
 * 타깃 페이지 id → 그 페이지를 가리키는 소스 페이지들.
 * 제목 매칭은 대소문자 무시. 자기참조 제외. 소스는 id로 중복제거.
 */
export function computeBacklinks(pages: PageLite[]): Record<string, { id: string; title: string }[]> {
  const idByTitle = buildTitleIndex(pages);

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
  const idByTitle = buildTitleIndex(pages);
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
  const idByTitle = buildTitleIndex(pages);

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

const CYPHER_LABELS: Record<string, string> = { doc: "Doc", project: "Project", decision: "Decision", lesson: "Lesson", task: "Task", risk: "Risk" };
const CYPHER_RELS = new Set(["link", "ref", "mention", "contains", "pair", "related"]);

/**
 * 위키/지식 그래프 → Cypher(Neo4j) 스크립트.
 * 노드 type → 라벨(Doc·Project·Decision·Lesson·Task·Risk, 그 외/없음=Doc),
 * 간선 kind → 관계(LINK·REF·MENTION·CONTAINS·PAIR·RELATED, 그 외/없음=LINKS_TO) + tag 가 있으면 {tag}.
 * 라벨·관계 이름은 이스케이프가 안 되므로 정해진 목록만 쓴다(값은 esc).
 */
export function graphToCypher(graph: {
  nodes: { id: string; title: string; type?: string }[];
  edges: { from: string; to: string; kind?: string; tag?: string }[];
}): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const label = (type?: string) => (type && Object.hasOwn(CYPHER_LABELS, type) ? CYPHER_LABELS[type] : "Doc");
  const labelOf = new Map(graph.nodes.map((n) => [n.id, label(n.type)]));
  const lines: string[] = [];
  for (const n of graph.nodes) {
    lines.push(`CREATE (\`${n.id}\`:${label(n.type)} {id:'${esc(n.id)}', title:'${esc(n.title)}'});`);
  }
  for (const e of graph.edges) {
    const rel = e.kind && CYPHER_RELS.has(e.kind) ? e.kind.toUpperCase() : "LINKS_TO";
    const props = e.tag ? ` {tag:'${esc(e.tag)}'}` : "";
    const la = labelOf.get(e.from) ?? "Doc";
    const lb = labelOf.get(e.to) ?? "Doc";
    lines.push(`MATCH (a:${la} {id:'${esc(e.from)}'}), (b:${lb} {id:'${esc(e.to)}'}) CREATE (a)-[:${rel}${props}]->(b);`);
  }
  return lines.join("\n");
}
