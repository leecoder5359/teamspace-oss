/* =====================================================================
   3-way 병합. 순수 함수(I/O·DOM 없음).

   왜 필요한가: 문서 저장은 baseRev 낙관적 잠금이라, 그 사이 다른 액터(사람이든
   에이전트든)가 먼저 저장했으면 409 가 난다. 덮어쓰기를 막는다는 목적은 옳은데,
   종전엔 그 다음에 사용자가 할 수 있는 게 **새로고침뿐**이었다 — 누르는 순간
   방금 쓴 내용이 사라진다(격차조사 D1).

   서버는 409 응답에 이미 currentMarkdown 을 실어 보낸다. 즉 병합에 필요한 세
   조각(base=내가 열 때의 본문, mine=지금 내 화면, theirs=서버 최신)이 전부
   손에 있는데 버리고 있었다. 여기서 합친다.

   **이 함수의 계약: 무엇도 버리지 않는다.** 겹치지 않는 변경은 둘 다 살리고,
   같은 자리를 다르게 고쳤으면 양쪽을 충돌 마커로 남긴다. 조용히 한쪽을 고르는
   일은 없다 — 그게 이 사고의 원인이었다.
   ===================================================================== */

/** base 의 [start,end) 구간이 lines 로 바뀌었다는 변경 단위. */
export type Hunk = { start: number; end: number; lines: string[] };

export type MergeResult = {
  text: string;
  /** 충돌 구간 수. 0 이면 그대로 저장해도 안전하다. */
  conflicts: number;
};

const normalize = (s: string) => s.replace(/\r\n?/g, "\n");

/* ───────────────────────── 라인 diff ───────────────────────── */

/**
 * 두 줄 배열의 최장 공통 부분수열(LCS) 길이표.
 * O(n·m) 이라 아주 큰 문서에선 무겁지만, 문서 본문 규모(수천 줄)에선 충분하다.
 */
function lcsTable(a: string[], b: string[]): Uint32Array {
  const w = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j] ? dp[(i + 1) * w + (j + 1)] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }
  return dp;
}

/**
 * base → next 로 가는 변경 훅 목록. 인접한 변경은 하나로 묶는다.
 * 반환 훅의 start/end 는 **base 기준 인덱스**다.
 */
export function diffLines(base: string[], next: string[]): Hunk[] {
  const dp = lcsTable(base, next);
  const w = next.length + 1;
  const hunks: Hunk[] = [];

  let i = 0;
  let j = 0;
  let pendStart = -1;
  let pendLines: string[] = [];

  const flush = (end: number) => {
    if (pendStart >= 0) {
      hunks.push({ start: pendStart, end, lines: pendLines });
      pendStart = -1;
      pendLines = [];
    }
  };

  while (i < base.length && j < next.length) {
    if (base[i] === next[j]) {
      flush(i);
      i++;
      j++;
      continue;
    }
    if (pendStart < 0) pendStart = i;
    // LCS 를 더 많이 남기는 쪽으로 이동 — 삭제(i++) vs 삽입(j++)
    if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      i++; // base 의 이 줄은 사라진다
    } else {
      pendLines.push(next[j]);
      j++; // next 의 이 줄은 새로 생긴다
    }
  }
  if (i < base.length || j < next.length) {
    if (pendStart < 0) pendStart = i;
    while (j < next.length) pendLines.push(next[j++]);
    i = base.length;
  }
  flush(i);
  return hunks;
}

/* ───────────────────────── 병합 ───────────────────────── */

const MARK_MINE = "<<<<<<< 내 편집";
const MARK_SEP = "=======";
const MARK_THEIRS = ">>>>>>> 서버(다른 곳에서 저장됨)";

const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * base 를 기준으로 mine·theirs 의 변경을 합친다.
 *
 * 규칙:
 *  - 겹치지 않는 훅 → 둘 다 적용
 *  - 겹치는데 결과가 같음 → 한 번만 적용
 *  - 겹치는데 다름 → 충돌 마커로 양쪽 보존
 */
export function merge3(baseRaw: string, mineRaw: string, theirsRaw: string): MergeResult {
  const base = normalize(baseRaw).split("\n");
  const mine = normalize(mineRaw).split("\n");
  const theirs = normalize(theirsRaw).split("\n");

  const mineHunks = diffLines(base, mine);
  const theirHunks = diffLines(base, theirs);

  const out: string[] = [];
  let conflicts = 0;
  let pos = 0; // base 커서
  let mi = 0;
  let ti = 0;

  while (mi < mineHunks.length || ti < theirHunks.length) {
    const m = mineHunks[mi];
    const t = theirHunks[ti];

    // 다음에 처리할 훅의 시작 위치
    const nextStart = Math.min(m ? m.start : Infinity, t ? t.start : Infinity);
    // 훅 앞의 공통 구간을 그대로 흘려보낸다
    for (; pos < nextStart && pos < base.length; pos++) out.push(base[pos]);

    const mActive = m && m.start <= pos;
    const tActive = t && t.start <= pos;

    if (mActive && tActive) {
      // 두 변경이 같은 자리에서 만난다
      if (m.start === t.start && m.end === t.end && sameLines(m.lines, t.lines)) {
        out.push(...m.lines); // 같은 수정 — 한 번만
      } else {
        conflicts++;
        out.push(MARK_MINE, ...m.lines, MARK_SEP, ...t.lines, MARK_THEIRS);
      }
      pos = Math.max(m.end, t.end);
      mi++;
      ti++;
      continue;
    }

    if (mActive) {
      // theirs 훅이 이 구간과 겹치면 충돌로 승격
      if (t && t.start < m.end) {
        conflicts++;
        out.push(MARK_MINE, ...m.lines, MARK_SEP, ...t.lines, MARK_THEIRS);
        pos = Math.max(m.end, t.end);
        mi++;
        ti++;
        continue;
      }
      out.push(...m.lines);
      pos = m.end;
      mi++;
      continue;
    }

    if (tActive) {
      if (m && m.start < t.end) {
        conflicts++;
        out.push(MARK_MINE, ...m.lines, MARK_SEP, ...t.lines, MARK_THEIRS);
        pos = Math.max(m.end, t.end);
        mi++;
        ti++;
        continue;
      }
      out.push(...t.lines);
      pos = t.end;
      ti++;
      continue;
    }

    break; // 방어: 진행 불가면 종료(무한루프 방지)
  }

  for (; pos < base.length; pos++) out.push(base[pos]);
  return { text: out.join("\n"), conflicts };
}

/* ───────────────────────── 충돌 요약 ───────────────────────── */

export type ConflictBlock = { mine: string; theirs: string };

/** 병합 결과에서 충돌 구간만 뽑아 화면에 나란히 보여주기 위한 요약. */
export function formatConflicts(merged: string): ConflictBlock[] {
  const lines = normalize(merged).split("\n");
  const out: ConflictBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("<<<<<<<")) {
      i++;
      continue;
    }
    const mine: string[] = [];
    const theirs: string[] = [];
    i++;
    while (i < lines.length && !lines[i].startsWith("=======")) mine.push(lines[i++]);
    i++; // separator
    while (i < lines.length && !lines[i].startsWith(">>>>>>>")) theirs.push(lines[i++]);
    i++; // end marker
    out.push({ mine: mine.join("\n"), theirs: theirs.join("\n") });
  }
  return out;
}

/** 본문에 아직 해결 안 된 충돌 마커가 남아 있는가(저장 전 가드). */
export function hasConflictMarkers(text: string): boolean {
  return /^<{7} |^={7}$|^>{7} /m.test(normalize(text));
}
