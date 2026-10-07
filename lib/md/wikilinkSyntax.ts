/* =====================================================================
   [[위키링크]] 경계 스캐너 — 파서·백링크·그래프가 모두 이것 하나를 쓴다.

   정규식 `\[\[([^\]]+)\]\]` 는 첫 `]` 에서 멈춰서 `[반장] 제목` 처럼
   대괄호로 시작하는 제목을 링크로 못 읽었다. 여기선 안쪽 대괄호의 짝을
   센다: 링크는 바깥 짝을 닫는 `]]` 에서 끝난다.
   - `[[[반장] 제목]]` → "[반장] 제목"
   - `[[[PLAN]]` → 0번 위치는 실패(안쪽 `[` 가 닫히지 않음) → 1번 위치의 [[PLAN]]
   - 짝 없는 `]` 가 나오면 그 위치는 링크가 아니다.
   ===================================================================== */

export type WikilinkMatch = {
  /** 소스 안 시작 위치(첫 `[`) */
  start: number;
  /** `]]` 바로 뒤 위치 */
  end: number;
  /** `[[` 와 `]]` 사이 원문(별칭 `|` 포함) */
  inner: string;
};

/** src[i] 에서 시작하는 [[...]] 를 읽는다. 아니면 null. */
export function matchWikilinkAt(src: string, i: number): WikilinkMatch | null {
  if (src[i] !== "[" || src[i + 1] !== "[") return null;
  let depth = 0;
  for (let j = i + 2; j < src.length; j++) {
    const ch = src[j];
    if (ch === "[") depth++;
    else if (ch === "]") {
      if (depth > 0) depth--;
      else if (src[j + 1] === "]") {
        if (j === i + 2) return null; // [[]] — 빈 링크
        return { start: i, end: j + 2, inner: src.slice(i + 2, j) };
      } else return null;
    }
  }
  return null;
}

/** 본문의 모든 [[...]] 를 앞에서부터(겹침 없이) 찾는다. */
export function* scanWikilinks(src: string): Generator<WikilinkMatch> {
  let i = src.indexOf("[[");
  while (i !== -1) {
    const m = matchWikilinkAt(src, i);
    if (m) {
      yield m;
      i = src.indexOf("[[", m.end);
    } else {
      i = src.indexOf("[[", i + 1);
    }
  }
}

/** [[...]] 를 모두 다른 문자열로 바꾼다(그래프 본문 정리용). */
export function replaceWikilinks(src: string, by: string): string {
  let out = "";
  let last = 0;
  for (const m of scanWikilinks(src)) {
    out += src.slice(last, m.start) + by;
    last = m.end;
  }
  return out + src.slice(last);
}
