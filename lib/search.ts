/* 전역 검색 헬퍼. snippet: 매칭 주변 텍스트 발췌(순수). */

export function snippet(text: string, q: string, len = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= len) return flat;

  const idx = flat.toLowerCase().indexOf(q.toLowerCase());
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
