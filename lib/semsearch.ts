/* =====================================================================
   개념 검색(LLM 질의 확장) — 임베딩 없이 로컬 claude 로 검색어를 동의어·연관어로
   확장해 재현율을 높인다. 확장어 파싱은 순수 함수(TDD), 확장만 LLM(lib/llm.complete).
   ===================================================================== */

/** 검색어 확장 프롬프트(연관 개념을 JSON 문자열 배열로 출력하도록 유도). */
export function buildExpansionPrompt(query: string): string {
  return [
    `사용자 검색어와 의미가 비슷하거나 관련된 핵심 개념·동의어·연관어를 한국어와 영어로 확장하라.`,
    `목적은 검색 재현율 향상. 너무 일반적인 단어(예: 것, 관리)는 제외. 최대 10개.`,
    `출력은 오직 JSON 문자열 배열 하나. 예: ["배포","릴리스","deploy","롤백"]. 코드펜스·설명 금지.`,
    ``,
    `검색어: ${query}`,
  ].join("\n");
}

/**
 * LLM 출력에서 확장어를 관대하게 파싱.
 * 첫 JSON 배열만 추출, 문자열만 채택, 소문자 트림·2자 미만/중복 제거.
 */
export function parseExpansion(text: string): string[] {
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

  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    if (typeof item !== "string") continue;
    const t = item.trim().toLowerCase();
    if (t.length < 2 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** 원 토큰 + 확장어 합집합(소문자 기준 중복 제거, 원 토큰 우선). */
export function mergeTerms(original: string[], expanded: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...original, ...expanded]) {
    const k = t.toLowerCase();
    if (k.length < 2 || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}
