/**
 * 낙관적 잠금 판정 (W2, 순수 로직).
 * baseRev / expectedUpdatedAt 은 opt-in — 클라이언트가 보냈을 때만 검사하고,
 * 불일치 시 서버 상태를 함께 돌려줘 어느 쪽 편집도 조용히 사라지지 않게 한다.
 */

export type RevCheck = { ok: true } | { ok: false; currentRev: number };

export function checkBaseRev(baseRev: number | null | undefined, currentRev: number): RevCheck {
  if (baseRev === null || baseRev === undefined || typeof baseRev !== "number" || !Number.isFinite(baseRev)) {
    return { ok: true }; // opt-in: 미제공/파싱 불가 → 검사 생략
  }
  if (baseRev === currentRev) return { ok: true };
  return { ok: false, currentRev };
}

export type UpdatedAtCheck = { ok: true } | { ok: false; currentUpdatedAt: string };

export function checkExpectedUpdatedAt(
  expected: string | null | undefined,
  actual: Date,
): UpdatedAtCheck {
  if (!expected) return { ok: true };
  const t = Date.parse(expected);
  if (Number.isNaN(t)) return { ok: true }; // 파싱 불가 → opt-in 미제공과 동일
  if (t === actual.getTime()) return { ok: true };
  return { ok: false, currentUpdatedAt: actual.toISOString() };
}
