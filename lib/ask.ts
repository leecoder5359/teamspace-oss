/* =====================================================================
   Vault Q&A — 검색·랭킹·추출형 답변(순수 로직, TDD).
   문서/결정 본문을 문단 단위로 점수화해 인용 가능한 패시지를 고른다.
   LLM 키가 있으면 이 결과를 합성 입력으로, 없으면 추출형 답변으로 그대로 쓴다.
   ===================================================================== */

// 한/영 혼용 불용어(검색 신호가 약한 토큰). 짧은 토큰(<2)도 제거.
const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "is", "are",
  "what", "how", "why", "who", "when", "where", "이", "그", "저", "것", "수",
  "은", "는", "이런", "그런", "에", "를", "을", "가", "의", "도", "와", "과",
  "어떻게", "무엇", "뭐", "왜", "어디", "언제", "누가", "알려줘", "해줘", "있어", "있나요", "인가요",
]);

/** 질의를 검색 토큰으로 분해(소문자·불용어/짧은토큰 제거·중복 제거). */
export function tokenize(q: string): string[] {
  const raw = (q || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const out: string[] = [];
  for (const t of raw) {
    if (t.length < 2 || STOPWORDS.has(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * 패시지 점수: 용어 빈도 + 커버리지(서로 다른 질의어 비율) 가중.
 * 커버리지를 크게 봐서 "여러 질의어를 두루 포함"하는 문단을 우대.
 */
export function scorePassage(text: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const hay = text.toLowerCase();
  let freq = 0;
  let covered = 0;
  for (const t of terms) {
    const n = countOccurrences(hay, t);
    if (n > 0) {
      covered++;
      freq += n;
    }
  }
  if (covered === 0) return 0;
  const coverage = covered / terms.length;
  // 빈도는 점감(로그)하여 한 단어 반복이 과대평가되지 않게.
  return coverage * 10 + Math.log2(1 + freq);
}

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    count++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return count;
}

export type Passage = {
  text: string;
  heading: string | null; // 패시지가 속한 가장 가까운 상위 제목(있으면)
  score: number;
};

/**
 * 마크다운을 문단(빈 줄 구분)으로 쪼개고 각 문단을 점수화해 상위 패시지를 반환.
 * 마크다운 헤딩(`#`)은 직후 문단들의 heading 컨텍스트로 추적(본문에서 제외).
 */
export function extractPassages(markdown: string, terms: string[], maxPassages = 2): Passage[] {
  const blocks = (markdown || "").replace(/\r\n/g, "\n").split(/\n{2,}/);
  let heading: string | null = null;
  const scored: Passage[] = [];

  for (const blockRaw of blocks) {
    const block = blockRaw.trim();
    if (!block) continue;
    const headingMatch = block.match(/^#{1,6}\s+(.*)$/m);
    // 블록이 헤딩만 있으면 컨텍스트만 갱신.
    if (/^#{1,6}\s+/.test(block) && block.split("\n").every((l) => /^#{1,6}\s+/.test(l.trim()) || !l.trim())) {
      heading = headingMatch ? headingMatch[1].trim() : heading;
      continue;
    }
    const text = block.replace(/^#{1,6}\s+/gm, "").trim();
    const score = scorePassage(text, terms);
    if (score > 0) scored.push({ text, heading, score });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, maxPassages);
}

export type SourceDoc = {
  id: string;
  title: string;
  kind: "doc" | "decision";
  body: string;
};

export type RankedSource = {
  id: string;
  title: string;
  kind: "doc" | "decision";
  score: number;
  passage: string;
  heading: string | null;
};

/**
 * 후보 문서들에서 패시지를 추출·랭킹해 상위 출처를 반환.
 * 문서 점수 = 최고 패시지 점수 + 제목 매칭 보너스.
 */
export function rankSources(candidates: SourceDoc[], terms: string[], topN = 5): RankedSource[] {
  const ranked: RankedSource[] = [];
  for (const c of candidates) {
    const titleBonus = scorePassage(c.title, terms) * 0.5;
    const passages = extractPassages(c.body, terms, 1);
    const best = passages[0];
    const score = (best?.score ?? 0) + titleBonus;
    if (score <= 0) continue;
    ranked.push({
      id: c.id,
      title: c.title,
      kind: c.kind,
      score,
      passage: best?.text.replace(/\s+/g, " ").trim().slice(0, 280) ?? "",
      heading: best?.heading ?? null,
    });
  }
  return ranked.sort((a, b) => b.score - a.score).slice(0, topN);
}

/**
 * 추출형 답변(LLM 없이): 상위 출처의 패시지를 인용 번호와 함께 묶어 보여준다.
 * 정직하게 "요약이 아니라 발췌"임을 드러낸다.
 */
export function buildExtractiveAnswer(ranked: RankedSource[]): string {
  if (ranked.length === 0) {
    return "관련 문서를 찾지 못했습니다. 질문을 더 구체적으로 적거나 문서를 먼저 추가해 보세요.";
  }
  const lines = ranked.slice(0, 3).map((r, i) => {
    const where = r.heading ? `${r.title} › ${r.heading}` : r.title;
    return `[${i + 1}] ${where}\n${r.passage}`;
  });
  return `관련 문서에서 찾은 근거입니다(발췌):\n\n${lines.join("\n\n")}`;
}
