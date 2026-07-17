/* =====================================================================
   provenance 태깅 — 문서의 핵심 주장을 근거 유형(추출/추론/모호)으로 분류.
   "어디까지가 문서에 적힌 사실이고 어디부터가 유추인가"를 가시화한다.
   프롬프트·파싱은 순수 함수(TDD), 분석만 LLM(lib/llm.complete).
   ===================================================================== */

export const PROVENANCE_TAGS = ["추출", "추론", "모호"] as const;
export type ProvenanceTag = (typeof PROVENANCE_TAGS)[number];

export type Claim = { claim: string; tag: ProvenanceTag; note: string };

/** 분석 프롬프트(문서→주장+태그 JSON 배열). */
export function buildProvenancePrompt(title: string, markdown: string): string {
  const body = (markdown || "").slice(0, 6000);
  return [
    `다음 문서의 핵심 주장(문장)을 뽑아 각 주장을 근거 유형으로 분류하라.`,
    `- 추출: 문서에 명시적으로 서술된 사실/내용`,
    `- 추론: 문서 내용에서 합리적으로 유추되지만 명시되지 않은 것`,
    `- 모호: 표현이 불분명하거나 근거가 약한 것`,
    `최대 15개. 각 주장과 이유는 한국어로 간결히.`,
    `출력은 오직 JSON 배열 하나. 형식: [{"claim":"주장","tag":"추출|추론|모호","note":"이유(짧게)"}]. 코드펜스·설명 금지.`,
    ``,
    `# ${title}`,
    body,
  ].join("\n");
}

const TAG_SET = new Set<string>(PROVENANCE_TAGS);

/** LLM 출력에서 주장 배열을 관대하게 파싱(첫 배열·유효 tag 만·캡). */
export function parseProvenance(text: string, cap = 30): Claim[] {
  if (!text) return [];
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const out: Claim[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const claim = typeof rec.claim === "string" ? rec.claim.trim() : "";
    const tag = typeof rec.tag === "string" ? rec.tag.trim() : "";
    if (!claim || !TAG_SET.has(tag)) continue;
    const note = typeof rec.note === "string" ? rec.note.trim() : "";
    out.push({ claim, tag: tag as ProvenanceTag, note });
    if (out.length >= cap) break;
  }
  return out;
}

/** 태그별 집계. */
export function countTags(claims: Claim[]): Record<ProvenanceTag, number> {
  const counts: Record<ProvenanceTag, number> = { 추출: 0, 추론: 0, 모호: 0 };
  for (const c of claims) counts[c.tag]++;
  return counts;
}
