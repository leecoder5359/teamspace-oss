/* =====================================================================
   검색 결과 랭킹·필터. 순수 함수(DB·React 없음).

   격차조사 G1: 종전 검색은 `ILIKE '%q%'` 로 긁어서 **랭킹이 아예 없었다**.
   제목이 정확히 일치한 문서와 본문 끄트머리에 한 번 스친 문서가 같은 취급을
   받았고, 결과 순서는 사실상 DB 가 돌려준 순서였다.

   여기서는 "왜 이 순서인가" 를 설명할 수 있게 점수를 나눈다:
     제목 정확일치 > 제목 앞부분 > 제목 포함 > 본문 다수 등장 > 본문 1회
   그리고 최근 수정된 것에 약한 가산을 준다 — 같은 관련도면 살아 있는 문서가
   위로 오는 게 맞다.

   ⚠️ 인덱스에 대해: pg_trgm GIN 을 깔아 `ILIKE` 가 인덱스를 탈 수 있게 했지만,
   트라이그램은 **3글자 미만 질의에서 무력**하다("배포" 같은 2음절). 그건 DB
   레이어의 한계이고 이 파일과는 무관하다 — 여기는 받은 후보를 줄 세울 뿐이다.
   ===================================================================== */

export type SearchKind = "doc" | "board" | "decision";

export type Candidate = {
  id: string;
  kind: SearchKind;
  title: string;
  body: string;
  projectId?: string | null;
  projectName?: string | null;
  updatedAt?: string | Date | null;
};

export type Ranked = Candidate & { score: number; snippet: string };

export type SearchFilters = {
  projectId?: string | null;
  kinds?: SearchKind[];
  /** ISO 날짜. 이 시각 **이후**로 수정된 것만 */
  from?: string | null;
  /** ISO 날짜. 이 시각 **이전**으로 수정된 것만 */
  to?: string | null;
};

/** 변형(공백 삽입·제거) 일치의 감점 비율. */
const VARIANT_FACTOR = 0.5;
/** 원문 일치에 얹는 층. scoreCandidate 최대(≈1240) 보다 커서, 원문 일치는 변형 전용 일치를 항상 이긴다. */
const ORIGINAL_TIER = 2000;

const norm = (s: string) => s.toLowerCase();

/** 대상 문자열에서 질의가 몇 번 나오는지(겹치지 않게). */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    const at = haystack.indexOf(needle, i);
    if (at < 0) return n;
    n++;
    i = at + needle.length;
  }
}

/**
 * 후보 하나의 점수.
 *
 * 제목 신호가 본문 신호를 항상 이긴다 — 사람이 검색할 때 떠올리는 건 대체로
 * 제목이고, 본문 우연 일치가 제목 일치를 밀어내면 "왜 이게 위지?" 가 된다.
 */
export function scoreCandidate(c: Candidate, query: string, now = Date.now()): number {
  const q = norm(query.trim());
  if (!q) return 0;
  const title = norm(c.title);
  const body = norm(c.body);

  let score = 0;
  if (title === q) score += 1000;
  else if (title.startsWith(q)) score += 600;
  else if (title.includes(q)) score += 400;

  const hits = countOccurrences(body, q);
  if (hits > 0) {
    // 많이 나올수록 관련 있지만 선형으로 주면 긴 문서가 항상 이긴다 — 로그로 눌러 준다
    score += 60 + Math.min(140, Math.round(40 * Math.log2(hits + 1)));
  }

  // 최근 가산은 **매칭이 있을 때만** 준다. 그러지 않으면 관련 없는 최신 문서가
  // 40점을 얻어 결과에 섞인다(rankSearch 는 score > 0 을 통과시킨다).
  if (score === 0) return 0;

  // 최대 40점, 180일에 걸쳐 감쇠. 관련도를 뒤집을 만큼은 아니다.
  const t = c.updatedAt ? new Date(c.updatedAt).getTime() : NaN;
  if (Number.isFinite(t)) {
    const days = Math.max(0, (now - t) / 86_400_000);
    score += Math.round(40 * Math.max(0, 1 - days / 180));
  }
  return score;
}

/** 필터를 통과하는가. 지정 안 한 필터는 통과로 본다. */
export function passesFilters(c: Candidate, f: SearchFilters): boolean {
  if (f.projectId) {
    // "미분류" 를 명시적으로 고를 수 있어야 한다
    if (f.projectId === "__none__") {
      if (c.projectId) return false;
    } else if (c.projectId !== f.projectId) return false;
  }
  if (f.kinds?.length && !f.kinds.includes(c.kind)) return false;

  if (f.from || f.to) {
    const t = c.updatedAt ? new Date(c.updatedAt).getTime() : NaN;
    // 시각을 모르는 항목은 기간 필터가 걸리면 뺀다 — 모르는 걸 통과시키면
    // "8월 이후" 로 걸러도 정체불명 항목이 섞여 나온다
    if (!Number.isFinite(t)) return false;
    if (f.from) {
      const a = Date.parse(f.from);
      if (Number.isFinite(a) && t < a) return false;
    }
    if (f.to) {
      const b = Date.parse(f.to);
      // to 는 그날 끝까지 포함(날짜만 준 경우 00:00 이라 하루가 통째로 빠진다)
      const end = /T/.test(f.to) ? b : b + 86_399_999;
      if (Number.isFinite(b) && t > end) return false;
    }
  }
  return true;
}

/** 매칭 주변을 발췌. lib/search 의 snippet 과 같은 규칙을 쓴다. */
export function makeSnippet(text: string, q: string, len = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= len) return flat;
  const idx = norm(flat).indexOf(norm(q));
  if (idx < 0) return flat.slice(0, len).trimEnd() + "…";
  const before = Math.floor((len - q.length) / 2);
  let start = Math.max(0, idx - before);
  const end = Math.min(flat.length, start + len);
  start = Math.max(0, end - len);
  let out = flat.slice(start, end).trim();
  if (start > 0) out = "…" + out;
  if (end < flat.length) out = out + "…";
  return out;
}

/**
 * 후보를 걸러 점수순으로 준다.
 * 동점은 최근 수정 → 제목 → id 로 갈라 **매번 같은 순서**가 나오게 한다.
 */
export function rankSearch(
  candidates: Candidate[],
  query: string,
  filters: SearchFilters = {},
  limit = 30,
  now = Date.now(),
  /** 공백 변형(lib/searchVariants). 원문 일치가 항상 우선하도록 변형 일치는 감점한다. */
  variants: string[] = [],
): Ranked[] {
  const q = query.trim();
  const out: Ranked[] = [];
  for (const c of candidates) {
    if (!passesFilters(c, filters)) continue;
    const original = scoreCandidate(c, q, now);
    let score = original > 0 ? ORIGINAL_TIER + original : 0;
    let hit = q;
    if (original <= 0) {
      for (const v of variants) {
        if (v === q) continue;
        const s = Math.round(scoreCandidate(c, v, now) * VARIANT_FACTOR);
        if (s > score) {
          score = s;
          hit = v;
        }
      }
    }
    if (score <= 0) continue;
    out.push({ ...c, score, snippet: makeSnippet(c.body || c.title, hit) });
  }
  out.sort(
    (a, b) =>
      b.score - a.score ||
      new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime() ||
      a.title.localeCompare(b.title) ||
      a.id.localeCompare(b.id),
  );
  return out.slice(0, limit);
}

/** 트라이그램 인덱스가 도움이 되는 길이인가(3글자 미만은 순차 스캔). */
export const TRIGRAM_MIN = 3;
export function usesTrigramIndex(query: string): boolean {
  return query.trim().length >= TRIGRAM_MIN;
}
