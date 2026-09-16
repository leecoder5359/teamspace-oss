/* =====================================================================
   행을 다른 보드로 옮길 때의 속성 재매핑 — 순수 함수.

   속성 id 는 보드마다 다르다(같은 템플릿으로 만든 '상태' 도 id 가 다르고,
   select 옵션 id 도 다르다). 그래서 **이름+타입** 으로 짝을 찾고, select 값은
   **옵션 이름** 으로 대상 옵션 id 를 찾는다. 짝을 못 찾은 값은 조용히 버리지
   않고 `dropped` 로 돌려준다 — 이동은 되돌리기 어렵고, 무엇이 사라지는지
   모른 채 옮기면 '상태가 사라졌다' 는 사고가 된다. 그래서 라우트는 dryRun 을
   먼저 쓰도록 안내한다.

   규칙:
   - text/number/date/checkbox/person: 같은 이름·타입이면 값 복사.
   - select: 원본 옵션 이름 → 대상 옵션 id. 대상에 그 이름이 없으면
     createMissingOptions 일 때 옵션을 만들고(색 유지), 아니면 버리고 보고.
   - multiselect: 값마다 select 와 같은 규칙. 없는 이름만 보고한다.
   - relation: 두 속성의 targetDatabaseId 가 같을 때만 복사(id 는 그 보드의 행이라
     대상이 다르면 뜻이 없다 — '선행 태스크' 처럼 자기 보드를 가리키는 relation 은
     보드가 바뀌면 반드시 끊긴다). 실재 여부 검증은 DB 가 필요해 라우트가 한다.
   - 제목(원본의 첫 text 속성)은 반드시 살아야 한다. 같은 이름 짝이 없으면 대상의
     제목 속성(첫 text)으로 옮기고, 그것도 없으면 거부한다.
   - 빈 값(undefined·null·''·[])은 매핑도 보고도 하지 않는다. checkbox false 는 값이다.
   ===================================================================== */

import { findTitleProp } from "@/lib/taskProps";
import { normalizeIds } from "@/lib/relation";

export type MoveOption = { id: string; name: string; color?: string };
export type MoveProp = {
  id: string;
  name: string;
  type: string;
  config?: { options?: MoveOption[]; targetDatabaseId?: string } | null;
};

export type MappedProp = { name: string; type: string; to?: string };
export type DroppedProp = { name: string; type: string; reason: string; value: unknown };
export type CreatedOption = { property: string; propertyId: string; option: MoveOption };

export type RowMovePlan =
  | {
      ok: true;
      props: Record<string, unknown>;
      mapped: MappedProp[];
      dropped: DroppedProp[];
      createdOptions: CreatedOption[];
    }
  | { ok: false; error: string; mapped: MappedProp[]; dropped: DroppedProp[] };

export function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

export function planRowMove(input: {
  source: MoveProp[];
  target: MoveProp[];
  props: Record<string, unknown>;
  createMissingOptions?: boolean;
  newId: () => string;
}): RowMovePlan {
  const { source, target, props, createMissingOptions = false, newId } = input;
  const out: Record<string, unknown> = {};
  const mapped: MappedProp[] = [];
  const dropped: DroppedProp[] = [];
  const createdOptions: CreatedOption[] = [];
  // 대상 속성별로 이번 이동에서 만들 옵션(같은 이름을 두 번 만들지 않게).
  const pending = new Map<string, MoveOption[]>();

  const srcTitle = source.find((p) => p.type === "text") ?? null; // findTitleProp 과 같은 규칙(첫 text) — text 가 없으면 제목 요구도 없다
  const used = new Set<string>();
  const sameNameType = (p: MoveProp) => target.find((t) => t.name === p.name && t.type === p.type) ?? null;

  // 먼저 이름+타입 짝을 확정해 둔다 — 제목 폴백이 다른 속성의 짝을 가로채지 않도록.
  const pair = new Map<string, MoveProp | null>();
  for (const p of source) {
    const t = sameNameType(p);
    if (t && !used.has(t.id)) {
      pair.set(p.id, t);
      used.add(t.id);
    } else pair.set(p.id, null);
  }
  if (srcTitle && !pair.get(srcTitle.id)) {
    const tTitle = findTitleProp(target.filter((t) => t.type === "text" && !used.has(t.id)));
    if (tTitle && tTitle.type === "text") {
      pair.set(srcTitle.id, tTitle);
      used.add(tTitle.id);
    }
  }

  const optionName = (p: MoveProp, id: unknown) =>
    typeof id === "string" ? (p.config?.options ?? []).find((o) => o.id === id) ?? null : null;

  /** 원본 옵션 → 대상 옵션 id. 못 만들면 null. */
  const resolveOption = (t: MoveProp, opt: MoveOption): string | null => {
    const hit = (t.config?.options ?? []).find((o) => o.name === opt.name);
    if (hit) return hit.id;
    const made = pending.get(t.id)?.find((o) => o.name === opt.name);
    if (made) return made.id;
    if (!createMissingOptions) return null;
    const option: MoveOption = { id: newId(), name: opt.name, ...(opt.color ? { color: opt.color } : {}) };
    pending.set(t.id, [...(pending.get(t.id) ?? []), option]);
    createdOptions.push({ property: t.name, propertyId: t.id, option });
    return option.id;
  };

  for (const p of source) {
    const value = props[p.id];
    if (isEmptyValue(value)) continue;
    const t = pair.get(p.id) ?? null;
    const entry = (): MappedProp => (t && t.name !== p.name ? { name: p.name, type: p.type, to: t.name } : { name: p.name, type: p.type });

    if (!t) {
      dropped.push({
        name: p.name,
        type: p.type,
        reason: p.id === srcTitle?.id ? "대상 보드에 제목(text) 속성이 없습니다" : "대상 보드에 같은 이름·타입의 속성이 없습니다",
        value,
      });
      continue;
    }

    if (p.type === "select") {
      const opt = optionName(p, value);
      if (!opt) {
        dropped.push({ name: p.name, type: p.type, reason: "원본 보드에 없는 옵션 id 입니다(끊긴 값)", value });
        continue;
      }
      const id = resolveOption(t, opt);
      if (!id) {
        dropped.push({ name: p.name, type: p.type, reason: `대상 속성에 '${opt.name}' 옵션이 없습니다`, value: opt.name });
        continue;
      }
      out[t.id] = id;
      mapped.push(entry());
      continue;
    }

    if (p.type === "multiselect") {
      const ids: string[] = [];
      const missing: string[] = [];
      for (const v of normalizeIds(value)) {
        const opt = optionName(p, v);
        const id = opt ? resolveOption(t, opt) : null;
        if (id) {
          if (!ids.includes(id)) ids.push(id);
        } else missing.push(opt ? opt.name : v);
      }
      if (missing.length) {
        dropped.push({ name: p.name, type: p.type, reason: "대상 속성에 없는 옵션입니다", value: missing });
      }
      if (ids.length) {
        out[t.id] = ids;
        mapped.push(entry());
      }
      continue;
    }

    if (p.type === "relation") {
      const srcTarget = p.config?.targetDatabaseId;
      if (!srcTarget || srcTarget !== t.config?.targetDatabaseId) {
        dropped.push({
          name: p.name,
          type: p.type,
          reason: "relation 의 대상 보드가 달라 행 id 가 뜻을 잃습니다",
          value: normalizeIds(value),
        });
        continue;
      }
      const ids = normalizeIds(value);
      if (ids.length === 0) continue;
      out[t.id] = ids;
      mapped.push(entry());
      continue;
    }

    out[t.id] = value;
    mapped.push(entry());
  }

  if (srcTitle && !pair.get(srcTitle.id)) {
    if (!dropped.some((d) => d.name === srcTitle.name && d.type === srcTitle.type)) {
      dropped.push({ name: srcTitle.name, type: srcTitle.type, reason: "대상 보드에 제목(text) 속성이 없습니다", value: props[srcTitle.id] ?? null });
    }
    return { ok: false, error: "대상 보드에 제목(text) 속성이 없어 옮길 수 없습니다.", mapped, dropped };
  }
  return { ok: true, props: out, mapped, dropped, createdOptions };
}
