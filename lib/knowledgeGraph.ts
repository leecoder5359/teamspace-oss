/* =====================================================================
   지식 그래프 — 문서·프로젝트·결정·레슨·태스크·리스크를 근거 태그가 붙은
   간선으로 잇는다. 순수 함수. 권한 필터는 호출자(lib/graphLoad)가 먼저 한다 —
   여기 들어온 것은 전부 '볼 수 있는 것'이라고 가정한다.

   간선 근거(설계: 지식 그래프 확장(Graphify 차용)):
     link     [[제목]]                               추출
     ref      본문의 문서·객체 id(전체 cuid / 유일한 9자 접두)  추출
     contains 부모→자식, 프로젝트→문서, 태스크→본문 문서     추출
     mention  본문에 다른 문서 제목 텍스트(6자 이상·유일)    추론
     pair     같은 식별자(W4-3 등)를 공유하는 2~4개 문서    추론
     related  LLM 이 고른 연관(GraphEdge 저장)             모호
   같은 쌍(방향 무관)은 간선 하나로 병합하고 tag 는 가장 강한 근거를 따른다.
   ===================================================================== */

import { buildTitleIndex, extractWikiTitles, normalizeTitle } from "./wikilink";
import { replaceWikilinks } from "./md/wikilinkSyntax";
import { buildMatcher } from "./ahoCorasick";

export type NodeType = "doc" | "project" | "decision" | "lesson" | "task" | "risk";
export type EdgeKind = "link" | "ref" | "mention" | "contains" | "pair" | "related";
export type EdgeTag = "추출" | "추론" | "모호";
export type GNode = { id: string; title: string; type: NodeType; href: string | null; projectId: string | null };
export type GEdge = { from: string; to: string; kind: EdgeKind; kinds: EdgeKind[]; tag: EdgeTag };
export type KGraph = { nodes: GNode[]; edges: GEdge[] };
export type GraphInput = {
  docs: { id: string; title: string; markdown: string | null; parentId: string | null; projectId: string | null }[];
  projects: { id: string; name: string }[];
  objects: {
    id: string;
    type: "decision" | "lesson" | "task" | "risk";
    title: string;
    text: string;
    projectId: string | null;
    boardId?: string | null;
    contentPageId?: string | null;
  }[];
  stored: { fromId: string; toId: string; kind: "related" }[];
};

export const KIND_TAG: Record<EdgeKind, EdgeTag> = {
  link: "추출", ref: "추출", contains: "추출", mention: "추론", pair: "추론", related: "모호",
};
/** 같은 쌍에서 대표 kind 를 고르는 우선순위(앞이 강함). */
const KIND_ORDER: EdgeKind[] = ["link", "ref", "contains", "mention", "pair", "related"];

const MENTION_MIN = 6;
const PAIR_MAX = 4;
const FULL_ID_RE = /\bc[a-z0-9]{24}\b/g;
const SHORT_ID_RE = /\bc[a-z0-9]{8}\b/g;
const FENCE_RE = /```[\s\S]*?```/g;
/** 문서 맨 앞 YAML 프론트매터(--- … ---). 별칭(aliases)은 buildTitleIndex 가 따로 읽는다. */
const FRONTMATTER_RE = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const WS_RE = /\s+/g;
/** 제목 앞 [태그] 를 뗀 뒤 첫 두 토큰 중 'W4-3'·'S2'·'P' 같은 식별자 */
const PAIR_TOKEN_RE = /^[A-Z]{1,3}\d*(?:-\d+)*$/;

const HREF: Record<Exclude<NodeType, "doc" | "task">, string> = {
  project: "/projects",
  decision: "/docs?cat=decisions",
  lesson: "/docs?cat=lessons",
  risk: "/docs?cat=risks",
};

/** 본문 정리: 코드펜스·위키링크 제거(위키링크는 link 로 따로 센다). */
function plainBody(md: string): string {
  return replaceWikilinks(md.replace(FENCE_RE, " "), " ");
}

function pairToken(title: string): string | null {
  const head = title.replace(/^\s*\[[^\]]*\]\s*/, "").trim().split(/\s+/).slice(0, 2);
  for (const t of head) if (PAIR_TOKEN_RE.test(t) && /\d/.test(t)) return t;
  return null;
}

export function buildGraph(input: GraphInput): KGraph {
  const docIds = new Set(input.docs.map((d) => d.id));
  const allNodes = new Map<string, GNode>();
  for (const d of input.docs) allNodes.set(d.id, { id: d.id, title: d.title, type: "doc", href: `/p/${d.id}`, projectId: d.projectId });
  for (const p of input.projects) allNodes.set(p.id, { id: p.id, title: p.name, type: "project", href: HREF.project, projectId: p.id });
  for (const o of input.objects) {
    const href = o.type === "task" ? (o.contentPageId ? `/p/${o.contentPageId}` : o.boardId ? `/p/${o.boardId}` : null) : HREF[o.type];
    allNodes.set(o.id, { id: o.id, title: o.title, type: o.type, href, projectId: o.projectId });
  }

  // 짧은 id(9자) → 노드 id. 겹치면 null(모호 → 무시)
  const shortIdx = new Map<string, string | null>();
  for (const id of allNodes.keys()) {
    const k = id.slice(0, 9);
    shortIdx.set(k, shortIdx.has(k) ? null : id);
  }

  // 제목 언급 색인: 6자 이상·유일 제목인 문서만
  // 공백은 접어서 비교한다(본문 쪽도 같은 규칙) — 줄바꿈·연속 공백 차이로 언급을 놓치지 않게
  const mentionKey = (title: string) => normalizeTitle(title).replace(WS_RE, " ");
  const titleCount = new Map<string, number>();
  for (const d of input.docs) titleCount.set(mentionKey(d.title), (titleCount.get(mentionKey(d.title)) ?? 0) + 1);
  const mentionTitles = input.docs
    .map((d) => ({ id: d.id, t: mentionKey(d.title) }))
    .filter((x) => x.t.length >= MENTION_MIN && titleCount.get(x.t) === 1);
  // 문서마다 제목 수만큼 includes 하던 것을 단일 패스로(의미 동일: 소문자 본문에 제목이 부분 문자열로 있음)
  const findMentions = buildMatcher(mentionTitles.map((x) => x.t));

  const titleIndex = buildTitleIndex(input.docs.map((d) => ({ id: d.id, title: d.title, markdown: d.markdown })));

  const merged = new Map<string, GEdge>();
  const add = (from: string, to: string, kind: EdgeKind) => {
    if (from === to || !allNodes.has(from) || !allNodes.has(to)) return;
    const key = from < to ? `${from}|${to}` : `${to}|${from}`;
    const cur = merged.get(key);
    if (!cur) {
      merged.set(key, { from, to, kind, kinds: [kind], tag: KIND_TAG[kind] });
      return;
    }
    if (!cur.kinds.includes(kind)) cur.kinds.push(kind);
    if (KIND_ORDER.indexOf(kind) < KIND_ORDER.indexOf(cur.kind)) {
      cur.kind = kind;
      cur.tag = KIND_TAG[kind];
      cur.from = from;
      cur.to = to;
    }
  };

  const scanText = (sourceId: string, raw: string) => {
    // 펜스 안 [[링크]] 는 link 로도 세지 않는다 — ref/언급(plainBody)과 일관되게.
    // (lib/wikilink computeBacklinks 는 아직 펜스 안 링크도 센다 — 범위 밖)
    // 프론트매터는 떼지 않는다 — Obsidian 속성 링크(related: "[[X]]")도 백링크 패널과 같이 link 로 센다.
    for (const t of extractWikiTitles(raw.replace(FENCE_RE, " "))) {
      const to = titleIndex.get(normalizeTitle(t));
      if (to) add(sourceId, to, "link");
    }
    // ref/언급은 프론트매터를 뺀 본문만(메타데이터의 id·제목이 가짜 간선이 되지 않게)
    const body = plainBody(raw.replace(FRONTMATTER_RE, ""));
    for (const m of body.matchAll(FULL_ID_RE)) add(sourceId, m[0], "ref");
    for (const m of body.matchAll(SHORT_ID_RE)) {
      const id = shortIdx.get(m[0]);
      if (id) add(sourceId, id, "ref");
    }
    const lower = body.toLowerCase().replace(WS_RE, " ");
    // 제목 순서대로 add — 간선 삽입 순서까지 예전 루프와 같게
    for (const i of [...findMentions(lower)].sort((a, b) => a - b)) add(sourceId, mentionTitles[i].id, "mention");
  };

  for (const d of input.docs) {
    scanText(d.id, d.markdown ?? "");
    if (d.parentId && docIds.has(d.parentId)) add(d.parentId, d.id, "contains");
    if (d.projectId) add(d.projectId, d.id, "contains");
  }
  for (const o of input.objects) {
    scanText(o.id, `${o.title}\n${o.text}`);
    if (o.type === "task" && o.contentPageId) add(o.id, o.contentPageId, "contains");
  }

  const groups = new Map<string, string[]>();
  for (const d of input.docs) {
    const tok = pairToken(d.title);
    if (tok) groups.set(tok, [...(groups.get(tok) ?? []), d.id]);
  }
  for (const ids of groups.values()) {
    if (ids.length < 2 || ids.length > PAIR_MAX) continue;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) add(ids[i], ids[j], "pair");
  }

  for (const s of input.stored) add(s.fromId, s.toId, "related");

  const edges = [...merged.values()];
  const touched = new Set(edges.flatMap((e) => [e.from, e.to]));
  // 문서는 항상, 그 외(프로젝트·객체)는 간선이 있을 때만
  const nodes = [...allNodes.values()].filter((n) => n.type === "doc" || touched.has(n.id));
  return { nodes, edges };
}
