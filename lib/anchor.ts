/* =====================================================================
   인라인 코멘트 앵커 (격차 D2) — 순수 함수.

   PageComment 는 페이지 단위 방명록이라 "이 문장이요" 를 말할 수 없었다.
   문장에 코멘트를 달려면 **위치를 기억**해야 하는데, 문서는 계속 편집되므로
   글자 오프셋만 저장하면 다음 저장 한 번에 전부 어긋난다.

   그래서 오프셋이 아니라 **인용문 + 앞뒤 문맥**을 저장하고(하이포시시스의
   TextQuoteSelector 와 같은 방식), 열 때마다 다시 찾는다:
     ① 인용문이 딱 하나면 그것
     ② 여럿이면 앞뒤 문맥이 가장 잘 맞는 것
     ③ 공백만 다른 경우까지 봐 준다
     ④ 그래도 없으면 **null** — 엉뚱한 곳에 붙이느니 "위치를 잃었다" 고 말한다.

   ④ 가 핵심이다. 억지로 어딘가에 붙이면 코멘트가 엉뚱한 문장을 가리킨 채
   맞는 것처럼 보이고, 그건 위치를 잃은 것보다 나쁘다.
   ===================================================================== */

export type TextAnchor = {
  /** 사용자가 고른 문구 */
  quote: string;
  /** 바로 앞 문맥(최대 32자) */
  prefix: string;
  /** 바로 뒤 문맥(최대 32자) */
  suffix: string;
};

const CONTEXT = 32;
/** 후보가 이보다 많으면 문맥 비교를 앞쪽 일부에서만 한다(아주 긴 문서 방어). */
const MAX_CANDIDATES = 200;

/** 선택 범위에서 앵커를 만든다. 빈 선택이면 null. */
export function createAnchor(text: string, start: number, end: number): TextAnchor | null {
  const [s, e] = start <= end ? [start, end] : [end, start];
  const quote = text.slice(s, e);
  if (!quote.trim()) return null;
  return {
    quote,
    prefix: text.slice(Math.max(0, s - CONTEXT), s),
    suffix: text.slice(e, e + CONTEXT),
  };
}

/** 공백 차이를 무시하고 비교하기 위한 정규화. */
const loose = (s: string) => s.replace(/\s+/g, " ").trim();

/** 두 문맥이 얼마나 맞는지(0~1). 끝에서부터 맞춰 본다 — 붙어 있는 쪽이 더 중요하다. */
function contextScore(actual: string, expected: string, fromEnd: boolean): number {
  const a = loose(actual);
  const b = loose(expected);
  if (!b) return 1; // 기대 문맥이 없으면 감점하지 않는다(문서 처음·끝)
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let match = 0;
  for (let i = 1; i <= len; i++) {
    const ca = fromEnd ? a[a.length - i] : a[i - 1];
    const cb = fromEnd ? b[b.length - i] : b[i - 1];
    if (ca !== cb) break;
    match++;
  }
  return match / b.length;
}

function allIndexes(hay: string, needle: string, limit = MAX_CANDIDATES): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = hay.indexOf(needle);
  while (i !== -1 && out.length < limit) {
    out.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return out;
}

/**
 * 편집된 본문에서 앵커의 현재 위치를 찾는다. 못 찾으면 null(고아 코멘트).
 */
export function locateAnchor(text: string, anchor: TextAnchor): { start: number; end: number } | null {
  if (!text || !anchor?.quote) return null;

  // ① 정확 일치
  const exact = allIndexes(text, anchor.quote);
  if (exact.length === 1) return { start: exact[0], end: exact[0] + anchor.quote.length };
  if (exact.length > 1) {
    const best = pickByContext(text, exact, anchor, anchor.quote.length);
    return { start: best, end: best + anchor.quote.length };
  }

  // ② 공백만 다른 경우 — 느슨한 비교로 다시 훑는다.
  const target = loose(anchor.quote);
  if (!target) return null;
  const words = target.split(" ");
  const first = words[0];
  const starts = allIndexes(text, first);
  for (const s of starts) {
    // 같은 단어 수만큼의 구간을 잡아 느슨히 비교한다
    const window = text.slice(s, s + anchor.quote.length + words.length * 4 + 8);
    const idx = looseMatchLength(window, target);
    if (idx > 0) return { start: s, end: s + idx };
  }
  return null;
}

/** window 앞부분이 target 과 (공백 무시) 같으면 그 실제 길이를 준다. 아니면 0. */
function looseMatchLength(window: string, target: string): number {
  let ti = 0;
  let wi = 0;
  while (ti < target.length && wi < window.length) {
    const tc = target[ti];
    const wc = window[wi];
    if (tc === " ") {
      if (/\s/.test(wc)) {
        while (wi < window.length && /\s/.test(window[wi])) wi++;
        ti++;
        continue;
      }
      return 0;
    }
    if (/\s/.test(wc) && wc !== tc) {
      // 원문에만 있는 공백은 건너뛴다
      wi++;
      continue;
    }
    if (tc !== wc) return 0;
    ti++;
    wi++;
  }
  return ti === target.length ? wi : 0;
}

/** 후보 중 앞뒤 문맥이 가장 잘 맞는 위치. */
function pickByContext(text: string, candidates: number[], anchor: TextAnchor, quoteLen: number): number {
  let best = candidates[0];
  let bestScore = -1;
  for (const c of candidates) {
    const before = text.slice(Math.max(0, c - CONTEXT), c);
    const after = text.slice(c + quoteLen, c + quoteLen + CONTEXT);
    const score = contextScore(before, anchor.prefix, true) + contextScore(after, anchor.suffix, false);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}
