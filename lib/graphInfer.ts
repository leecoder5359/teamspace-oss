/* LLM 연관 간선 — 결정적 근거가 없는 문서에 '관련 문서'를 고르게 한다. 프롬프트·후보 선정·파싱만(순수). */

import { similarTo, type VectorIndex } from "@/lib/vector";

/** 한 번의 LLM 호출에 싣는 후보 상한 — 전체 문서(수백 개)를 다 실으면 프롬프트가 ~19KB 로 커진다. */
export const MAX_CANDIDATES = 60;

/**
 * 대상 문서의 후보 목록: TF-IDF 유사도 상위부터, 0점 초과가 모자라면 나머지를 제목순으로 채워 최대 max 개.
 * idx 는 호출자가 볼 수 있는 문서로만 만든 색인이어야 하고, docs 도 같은 집합이어야 한다(D3).
 */
export function rankCandidates(
  idx: VectorIndex,
  targetId: string,
  docs: { id: string; title: string }[],
  max = MAX_CANDIDATES,
): { id: string; title: string }[] {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const out: { id: string; title: string }[] = [];
  const seen = new Set<string>([targetId]);
  for (const s of similarTo(idx, targetId, max)) {
    const d = byId.get(s.id);
    if (!d || seen.has(d.id)) continue;
    seen.add(d.id);
    out.push({ id: d.id, title: d.title });
  }
  if (out.length < max) {
    const rest = docs.filter((d) => !seen.has(d.id)).sort((a, b) => a.title.localeCompare(b.title, "ko"));
    for (const d of rest) {
      if (out.length >= max) break;
      out.push({ id: d.id, title: d.title });
    }
  }
  return out;
}

const BODY_MAX = 2000;

const oneLine = (t: string) => t.replace(/[\t\r\n]+/g, " ");

export function buildRelatedPrompt(doc: { title: string; body: string }, candidates: { id: string; title: string }[]): string {
  return [
    `아래 [대상 문서]와 내용상 가장 관련 깊은 문서를 [후보] 목록에서 최대 3개 골라라.`,
    `관련이 확실하지 않으면 적게 고르거나 빈 배열을 내라. 후보 목록에 없는 id 는 쓰지 마라.`,
    `출력은 오직 JSON 배열 하나: [{"id":"후보 id","reason":"한국어 한 줄 이유"}]. 코드펜스·설명 금지.`,
    ``,
    `[대상 문서]`,
    `# ${oneLine(doc.title)}`,
    (doc.body || "").slice(0, BODY_MAX),
    ``,
    `[후보] (id<TAB>제목)`,
    ...candidates.map((c) => `${c.id}\t${oneLine(c.title)}`),
  ].join("\n");
}

export function parseRelated(text: string, candidateIds: Set<string>, cap = 3): { id: string; reason: string }[] {
  const s = text.indexOf("[");
  const e = text.lastIndexOf("]");
  if (s < 0 || e <= s) return [];
  let arr: unknown;
  try { arr = JSON.parse(text.slice(s, e + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: { id: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const it of arr) {
    if (!it || typeof it !== "object") continue;
    const r = it as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    if (!candidateIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, reason: typeof r.reason === "string" ? r.reason.trim().slice(0, 200) : "" });
    if (out.length >= cap) break;
  }
  return out;
}
