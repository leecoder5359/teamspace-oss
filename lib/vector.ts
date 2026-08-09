/* =====================================================================
   벡터 검색 (격차 G2) — 순수 함수. 외부 API 키가 필요 없다.

   **먼저 정직하게**: 이건 신경망 임베딩이 아니다. TF-IDF 가중 가방(bag-of-words)
   벡터의 코사인 유사도다. 그래서 "환불"과 "리펀드" 처럼 **글자가 겹치지 않는
   동의어는 못 잇는다**. 진짜 임베딩은 외부 임베딩 API(키)가 필요하고, 이 저장소는
   키리스 원칙이라(그리고 env 접근이 정책상 막혀 있어) 지금 넣을 수 없다.

   그럼 왜 만드나. 지금 없는 능력이 이걸로 생기기 때문이다:
   - **"이 문서와 비슷한 문서"** — 질의어 없이 문서 자체로 이웃을 찾는다.
     기존 검색(G1 랭킹)·개념검색(LLM 질의확장)은 둘 다 '질의어'가 있어야 한다.
   - IDF 가중 — 모든 문서에 나오는 흔한 낱말("문서", "합니다")의 표를 깎는다.

   동의어는 이미 있는 개념검색(LLM 질의확장)이 맡는다. 둘은 경쟁이 아니라 보완이고,
   나중에 임베딩 API 를 붙이면 vectorize() 하나만 갈아끼우면 되도록 갈라 뒀다.
   ===================================================================== */

export type VecDoc = { id: string; title: string; text: string };
export type Vector = Map<string, number>;
export type VectorIndex = {
  ids: string[];
  /** id → L2 정규화된 TF-IDF 벡터 */
  vectors: Map<string, Vector>;
  /** 낱말 → IDF */
  idf: Map<string, number>;
};

/** 제목 가중치 — 제목은 사람이 고른 요약이라 본문 한 번보다 무겁게 본다. */
const TITLE_WEIGHT = 3;
const MIN_SCORE = 1e-6;

/**
 * 글 → 낱말 가방. 한국어는 공백 분절이 거칠어서 **2글자 문자 n-gram** 도 함께 넣는다
 * (조사가 붙은 "배포를" 과 "배포" 가 최소한 부분적으로 맞도록).
 */
export function vectorize(text: string): Vector {
  const v: Vector = new Map();
  const add = (k: string, w = 1) => v.set(k, (v.get(k) ?? 0) + w);

  const cleaned = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ");
  const words = cleaned.split(/\s+/).filter((w) => w.length > 1);
  for (const w of words) {
    add(w);
    // 한글 낱말은 조사·어미가 붙으므로 2글자 n-gram 으로 부분 일치를 만든다
    if (/[가-힣]/.test(w) && w.length > 2) {
      for (let i = 0; i + 2 <= w.length; i++) add(`#${w.slice(i, i + 2)}`, 0.5);
    }
  }
  return v;
}

function norm(v: Vector): Vector {
  let sum = 0;
  for (const x of v.values()) sum += x * x;
  const len = Math.sqrt(sum);
  if (len === 0) return v;
  const out: Vector = new Map();
  for (const [k, x] of v) out.set(k, x / len);
  return out;
}

/** 코사인 유사도. 둘 다 정규화돼 있다고 가정하지 않고 안전하게 계산한다. */
export function cosine(a: Vector, b: Vector): number {
  if (a.size === 0 || b.size === 0) return 0;
  // 작은 쪽을 돌아야 빠르다
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [k, x] of small) {
    const y = big.get(k);
    if (y !== undefined) dot += x * y;
  }
  if (dot === 0) return 0;
  let na = 0;
  for (const x of a.values()) na += x * x;
  let nb = 0;
  for (const x of b.values()) nb += x * x;
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

/** 문서 묶음으로 색인을 만든다(IDF 계산 + 정규화 벡터). */
export function buildIndex(docs: VecDoc[]): VectorIndex {
  const raw = new Map<string, Vector>();
  const df = new Map<string, number>();

  for (const d of docs) {
    const v = vectorize(d.text);
    for (const [k, w] of vectorize(d.title)) v.set(k, (v.get(k) ?? 0) + w * TITLE_WEIGHT);
    raw.set(d.id, v);
    for (const k of v.keys()) df.set(k, (df.get(k) ?? 0) + 1);
  }

  const N = Math.max(1, docs.length);
  const idf = new Map<string, number>();
  for (const [k, n] of df) idf.set(k, Math.log((N + 1) / (n + 0.5)) + 1);

  const vectors = new Map<string, Vector>();
  for (const [id, v] of raw) {
    const weighted: Vector = new Map();
    for (const [k, tf] of v) weighted.set(k, (1 + Math.log(tf)) * (idf.get(k) ?? 1));
    vectors.set(id, norm(weighted));
  }
  return { ids: docs.map((d) => d.id), vectors, idf };
}

function queryVector(idx: VectorIndex, text: string): Vector {
  const v = vectorize(text);
  const weighted: Vector = new Map();
  for (const [k, tf] of v) {
    const w = idx.idf.get(k);
    // 색인에 없는 낱말은 어느 문서와도 안 맞으므로 버린다
    if (w !== undefined) weighted.set(k, (1 + Math.log(tf)) * w);
  }
  return norm(weighted);
}

/** 질의로 문서 찾기. 0점 문서는 넣지 않는다(억지로 채우면 '관련 있음'처럼 보인다). */
export function searchVectors(idx: VectorIndex, query: string, limit = 10): { id: string; score: number }[] {
  const q = queryVector(idx, query);
  if (q.size === 0) return [];
  const out: { id: string; score: number }[] = [];
  for (const [id, v] of idx.vectors) {
    const score = cosine(q, v);
    if (score > MIN_SCORE) out.push({ id, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 이 문서와 비슷한 문서. 자기 자신은 뺀다. */
export function similarTo(idx: VectorIndex, id: string, limit = 5): { id: string; score: number }[] {
  const self = idx.vectors.get(id);
  if (!self) return [];
  const out: { id: string; score: number }[] = [];
  for (const [other, v] of idx.vectors) {
    if (other === id) continue;
    const score = cosine(self, v);
    if (score > MIN_SCORE) out.push({ id: other, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
