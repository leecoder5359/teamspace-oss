/* =====================================================================
   relation 속성 (격차 C2) — 순수 함수.

   `relation` 은 스키마의 PropType 에 이름만 있고 저장·렌더링이 **아예 없었다**.
   그래서 생성 자체를 막아 뒀는데(전수조사 D18), 정작 `pnpm ws task block`
   (의존관계 등록)은 그 타입을 만들려 해서 **400 으로 죽어 있었다** — SKILL.md 는
   그 명령을 광고하고 있었다. 계약과 구현이 어긋난 전형이다.

   저장 형태: 대상 보드의 **행 id 배열**(`string[]`). 순서는 사용자가 정한 것으로
   보고 보존한다(정렬해 버리면 "먼저 할 일" 같은 의미가 사라진다).
   ===================================================================== */

/** 저장된 값을 id 배열로 정규화. 단일 문자열(옛 데이터)도 받는다. */
export function normalizeIds(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const id = v.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** 있으면 빼고 없으면 넣는다(원본 불변). */
export function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/**
 * 대상 보드에 실재하는 id 와 아닌 것을 가른다.
 * 모르는 id 를 조용히 버리지 않는다 — 400 으로 돌려줘야 호출자가 오타를 안다.
 */
export function partitionKnown(ids: string[], known: Set<string>): { known: string[]; unknown: string[] } {
  const ok: string[] = [];
  const bad: string[] = [];
  for (const id of ids) (known.has(id) ? ok : bad).push(id);
  return { known: ok, unknown: bad };
}

/**
 * 칩으로 보일 제목 목록. 제목을 못 찾으면 **"(삭제된 행)"** 으로 표시한다 —
 * 빼 버리면 연결이 사라진 걸 아무도 모른다.
 */
export function relationLabel(
  ids: string[],
  titleOf: (id: string) => string | null,
  max = 2,
): { shown: string[]; overflow: number } {
  const shown = ids.slice(0, max).map((id) => titleOf(id) ?? "(삭제된 행)");
  return { shown, overflow: Math.max(0, ids.length - shown.length) };
}

/** 순서까지 같은지. 저장 전 변경 여부 판단에 쓴다. */
export function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/* ── 의존관계 표시 (격차 C6) ─────────────────────────────────────────
   relation 으로 이어 둔 '선행 태스크' 가 아직 안 끝났으면 막혀 있는 것이다.
   그 사실을 어디에도 안 보여 주면 의존관계를 적어 둘 이유가 없다.
   '끝났나' 판정은 상태 옵션 **이름**으로 본다 — 옵션 id 는 보드마다 다르고,
   완료 열의 이름은 사람이 정한 그대로가 가장 정확한 신호다. */

/** 상태 옵션 이름이 '끝남'을 뜻하나. */
export function isDoneLabel(label: string | null | undefined): boolean {
  if (!label) return false;
  return /완료|done|closed|끝|해결|완결/i.test(label.trim());
}

/**
 * 이 행을 막고 있는 선행 행들. 선행이 없거나 전부 끝났으면 빈 배열.
 * @param blockerIds 이 행의 relation 값(선행 행 id)
 * @param statusOf   행 id → 상태 옵션 이름(모르면 null)
 */
export function blockingIds(blockerIds: string[], statusOf: (id: string) => string | null): string[] {
  return blockerIds.filter((id) => !isDoneLabel(statusOf(id)));
}
