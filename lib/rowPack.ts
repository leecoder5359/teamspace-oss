/* =====================================================================
   객체 배열 ↔ 열 이름 + 값 행렬. 서버 → 클라 페이로드에서 키 이름 반복을 걷어낸다.

   사이드바 첫 목록(문서 500여 개 × 필드 14개)은 값보다 키 이름이 더 컸다("restrictedSelf":false 가
   문서마다 반복). 모양만 바꿔 실어 보내고 클라에서 원래 객체로 되돌리므로 받는 쪽 동작은 그대로다.
   없는 키(undefined)는 되돌릴 때도 없는 키로 남긴다.
   ===================================================================== */

export type PackedRows<T> = { cols: (keyof T & string)[]; rows: unknown[][] };

export function packRows<T extends object>(items: T[]): PackedRows<T> {
  const cols: (keyof T & string)[] = [];
  const seen = new Set<string>();
  for (const it of items)
    for (const k of Object.keys(it))
      if (!seen.has(k)) {
        seen.add(k);
        cols.push(k as keyof T & string);
      }
  // 값이 undefined 인 칸은 null 과 구분해야 한다 — 0 길이 배열이 아닌 표식으로 둔다.
  return { cols, rows: items.map((it) => cols.map((c) => (c in it ? (it as Record<string, unknown>)[c] : MISSING))) };
}

/** 없는 키 표식 — JSON·RSC 어느 쪽으로 보내도 살아남는 값. */
const MISSING = { $m: 1 } as const;
const isMissing = (v: unknown) => typeof v === "object" && v !== null && (v as { $m?: unknown }).$m === 1 && Object.keys(v).length === 1;

export function unpackRows<T>(p: PackedRows<T>): T[] {
  return p.rows.map((r) => {
    const o: Record<string, unknown> = {};
    p.cols.forEach((c, i) => {
      if (!isMissing(r[i])) o[c] = r[i];
    });
    return o as T;
  });
}

export const isPacked = <T>(v: unknown): v is PackedRows<T> =>
  typeof v === "object" && v !== null && Array.isArray((v as PackedRows<T>).cols) && Array.isArray((v as PackedRows<T>).rows);
