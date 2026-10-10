/**
 * 그래프 추론 대상 선정(순수). Page.inferTriedAt 이 있는 문서는 건너뛴다.
 * retryBefore 가 있으면 그 시각 이전에 시도한 문서만 다시 후보(그 시각 이후 시도는 건너뜀) —
 * 한 번의 --retry --all 실행 안에서 문서가 한 번만 재시도되어 반복이 끝난다.
 * remaining = 후보 수 − batch 길이.
 */
export function selectInferTargets<T extends { id: string }>(
  weak: readonly T[],
  tried: ReadonlyMap<string, Date>,
  opts: { retryBefore?: Date | null; limit: number },
): { batch: T[]; remaining: number } {
  const cutoff = opts.retryBefore ?? null;
  const candidates = weak.filter((d) => {
    const at = tried.get(d.id);
    return at === undefined || (cutoff !== null && at < cutoff);
  });
  const batch = candidates.slice(0, opts.limit);
  return { batch, remaining: candidates.length - batch.length };
}
