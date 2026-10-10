/* 검색어 공백 변형. "인증코어" 가 "인증 코어" 문서를 못 찾던 문제(0건 vs 26건)를 푼다.
   순수 함수. 원문이 항상 첫 번째이고, 최대 MAX_VARIANTS 개. */

export const MAX_VARIANTS = 8;

export function queryVariants(q: string): string[] {
  const orig = q.trim();
  if (!orig) return [];
  const out: string[] = [orig];
  const add = (v: string) => {
    if (v && !out.includes(v) && out.length < MAX_VARIANTS) out.push(v);
  };
  add(orig.replace(/\s+/g, ""));
  const chars = Array.from(orig);
  if (!/\s/.test(orig) && chars.length >= 3 && chars.length <= 12) {
    for (let i = 1; i < chars.length; i++) add(chars.slice(0, i).join("") + " " + chars.slice(i).join(""));
  }
  return out;
}
