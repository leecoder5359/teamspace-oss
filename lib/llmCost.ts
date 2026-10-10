/* =====================================================================
   LLM 비용 추정(순수) — 공개 단가(USD / 1M tokens) 기준의 근사치.
   모델 이름 부분 일치: haiku 1/5 · sonnet 3/15 · opus 5/25 · 그 밖은 모름(null).
   실제 청구와 다를 수 있다(캐시 할인·구독 요금제 등은 반영하지 않는다).
   ===================================================================== */

const PRICES: { match: string; inPerM: number; outPerM: number }[] = [
  { match: "haiku", inPerM: 1, outPerM: 5 },
  { match: "sonnet", inPerM: 3, outPerM: 15 },
  { match: "opus", inPerM: 5, outPerM: 25 },
];

export function priceFor(model: string): { inPerM: number; outPerM: number } | null {
  const m = (model || "").toLowerCase();
  const p = PRICES.find((x) => m.includes(x.match));
  return p ? { inPerM: p.inPerM, outPerM: p.outPerM } : null;
}

/** 토큰이 둘 다 없거나 단가를 모르면 null. 한쪽만 있으면 없는 쪽은 0 으로 본다. */
export function estimateUsd(model: string, inputTokens: number | null, outputTokens: number | null): number | null {
  if (inputTokens === null && outputTokens === null) return null;
  const p = priceFor(model);
  if (!p) return null;
  return ((inputTokens ?? 0) * p.inPerM + (outputTokens ?? 0) * p.outPerM) / 1_000_000;
}
