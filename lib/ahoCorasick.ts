/* =====================================================================
   Aho–Corasick 다중 패턴 매처 — 텍스트 한 번 훑기로 "어떤 패턴이 부분 문자열로
   들어있나"를 답한다. 의미는 patterns.filter(p => text.includes(p)) 와 같다
   (UTF-16 코드 단위 비교, 대소문자 그대로 — 필요하면 호출자가 미리 소문자화).
   지식 그래프의 제목 언급(문서 수 × 제목 수 includes)을 대체한다.
   ===================================================================== */

/** patterns 로 오토마톤을 한 번 만들고, text → 들어있는 패턴 인덱스 집합 을 돌려주는 함수를 반환. */
export function buildMatcher(patterns: readonly string[]): (text: string) => Set<number> {
  const next: Map<number, number>[] = [new Map()];
  const own: number[][] = [[]]; // 이 노드에서 끝나는 패턴
  const fail: number[] = [0];
  const dict: number[] = [-1]; // 실패 사슬에서 가장 가까운 '출력 있는' 노드
  const always: number[] = []; // 빈 패턴은 항상 일치("".includes 와 동일)

  patterns.forEach((p, i) => {
    if (p.length === 0) return void always.push(i);
    let s = 0;
    for (let k = 0; k < p.length; k++) {
      const c = p.charCodeAt(k);
      let t = next[s].get(c);
      if (t === undefined) {
        t = next.length;
        next.push(new Map());
        own.push([]);
        fail.push(0);
        dict.push(-1);
        next[s].set(c, t);
      }
      s = t;
    }
    own[s].push(i);
  });

  // BFS 로 실패·사전 링크
  const queue: number[] = [];
  for (const t of next[0].values()) queue.push(t);
  for (let qi = 0; qi < queue.length; qi++) {
    const s = queue[qi];
    for (const [c, t] of next[s]) {
      let f = fail[s];
      while (f !== 0 && !next[f].has(c)) f = fail[f];
      const g = next[f].get(c);
      fail[t] = g !== undefined && g !== t ? g : 0;
      dict[t] = own[fail[t]].length ? fail[t] : dict[fail[t]];
      queue.push(t);
    }
  }

  // 핫 루프 가속: 어떤 패턴에도 없는 문자는 곧장 루트로, 루트 전이는 배열로,
  // 실패 링크를 따라 해결한 전이는 노드별로 기억(지연 DFA).
  const inAlpha = new Uint8Array(65536);
  for (const p of patterns) for (let k = 0; k < p.length; k++) inAlpha[p.charCodeAt(k)] = 1;
  const rootNext = new Int32Array(65536);
  for (const [c, t] of next[0]) rootNext[c] = t;
  const resolved: Map<number, number>[] = next.map((m) => new Map(m));
  const step = (s: number, c: number): number => {
    if (!inAlpha[c]) return 0;
    if (s === 0) return rootNext[c];
    const r = resolved[s].get(c);
    if (r !== undefined) return r;
    const t = step(fail[s], c);
    resolved[s].set(c, t);
    return t;
  };

  return (text: string) => {
    const hit = new Set<number>(always);
    const seen = new Uint8Array(next.length); // 사슬을 이미 다 내보낸 노드
    let s = 0;
    for (let k = 0; k < text.length; k++) {
      s = step(s, text.charCodeAt(k));
      if (s === 0) continue;
      for (let o = own[s].length ? s : dict[s]; o > 0 && !seen[o]; o = dict[o]) {
        seen[o] = 1;
        for (const i of own[o]) hit.add(i);
      }
    }
    return hit;
  };
}
