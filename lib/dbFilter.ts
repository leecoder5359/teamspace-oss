/* =====================================================================
   보드 필터 엔진. 순수 함수(React·DOM 없음).

   격차조사 C4: 종전 필터는 **select 속성의 등가 비교 하나뿐**이었다.
   `props[propId] === optId` 가 전부라, "마감일이 지난 것", "담당자가 비어 있는
   것", "제목에 X 가 든 것" 같은 흔한 질문에 답할 수 없었다. AND/OR 도 없었다.

   여기서는 규칙을 값 타입에 맞춰 정하고, 그룹으로 묶어 AND/OR 를 준다.
   비교는 전부 이 파일 안에서 끝난다 — UI 는 규칙을 만들기만 한다.
   ===================================================================== */

export type FilterOp =
  | "eq" // 같다
  | "ne" // 다르다
  | "contains" // 포함
  | "notContains"
  | "empty" // 비어 있다
  | "notEmpty"
  | "gt" // 초과 / 이후
  | "lt" // 미만 / 이전
  | "checked" // 체크됨
  | "unchecked";

export type FilterRule = {
  propId: string;
  op: FilterOp;
  /** eq/ne/contains/gt/lt 에서만 쓴다. 나머지 연산자는 무시한다. */
  value?: string | number | null;
};

export type FilterGroup = {
  conj: "and" | "or";
  rules: FilterRule[];
};

/** 값 종류별로 고를 수 있는 연산자. UI 가 이 목록으로 드롭다운을 만든다. */
export const OPS_BY_KIND = {
  select: ["eq", "ne", "empty", "notEmpty"],
  text: ["contains", "notContains", "eq", "empty", "notEmpty"],
  number: ["eq", "ne", "gt", "lt", "empty", "notEmpty"],
  date: ["eq", "gt", "lt", "empty", "notEmpty"],
  checkbox: ["checked", "unchecked"],
} as const satisfies Record<string, readonly FilterOp[]>;

export type FilterKind = keyof typeof OPS_BY_KIND;

export const OP_LABEL: Record<FilterOp, string> = {
  eq: "같음",
  ne: "다름",
  contains: "포함",
  notContains: "미포함",
  empty: "비어 있음",
  notEmpty: "값 있음",
  gt: "초과·이후",
  lt: "미만·이전",
  checked: "체크됨",
  unchecked: "체크 안 됨",
};

/** 속성 타입 → 필터 종류. 알 수 없으면 text 로 다룬다(항상 뭔가는 걸 수 있게). */
export function filterKindOf(propType: string): FilterKind {
  switch (propType) {
    case "select":
    case "multiselect":
    case "person":
      return "select";
    case "number":
      return "number";
    case "date":
      return "date";
    case "checkbox":
      return "checkbox";
    default:
      return "text";
  }
}

const isEmptyValue = (v: unknown): boolean =>
  v == null || v === "" || (Array.isArray(v) && v.length === 0);

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toTime(v: unknown): number | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

const asText = (v: unknown): string =>
  v == null ? "" : Array.isArray(v) ? v.join(" ") : String(v);

/**
 * 규칙 하나를 값에 적용한다.
 *
 * 비교 불가한 조합(숫자 규칙인데 값이 글자 등)은 **false** 다. 조용히 통과시키면
 * 필터가 걸린 줄 알았는데 안 걸리는 게 되고, 그게 이 프로젝트에서 반복해서
 * 문제가 된 '조용한 실패' 다.
 */
export function matchRule(value: unknown, rule: FilterRule, kind: FilterKind): boolean {
  switch (rule.op) {
    case "empty":
      return isEmptyValue(value);
    case "notEmpty":
      return !isEmptyValue(value);
    case "checked":
      return value === true;
    case "unchecked":
      return value !== true;
  }

  // 값이 필요한 연산자인데 값이 없으면 필터를 걸지 않은 것으로 본다
  // (작성 중인 미완성 규칙이 결과를 0건으로 만들면 쓰기가 괴롭다)
  if (rule.value == null || rule.value === "") return true;

  if (kind === "number") {
    const a = toNumber(value);
    const b = toNumber(rule.value);
    if (a == null || b == null) return false;
    return rule.op === "eq" ? a === b : rule.op === "ne" ? a !== b : rule.op === "gt" ? a > b : a < b;
  }

  if (kind === "date") {
    const a = toTime(value);
    const b = toTime(rule.value);
    if (a == null || b == null) return false;
    return rule.op === "eq" ? a === b : rule.op === "gt" ? a > b : a < b;
  }

  if (kind === "select") {
    // 다중값(multiselect)은 포함 여부로 본다
    const v = rule.value;
    const has = Array.isArray(value) ? value.includes(v) : value === v;
    return rule.op === "ne" ? !has : has;
  }

  // text
  const hay = asText(value).toLowerCase();
  const needle = String(rule.value).toLowerCase();
  switch (rule.op) {
    case "eq":
      return hay === needle;
    case "ne":
      return hay !== needle;
    case "contains":
      return hay.includes(needle);
    case "notContains":
      return !hay.includes(needle);
    default:
      return true;
  }
}

export type PropLike = { id: string; type: string };

/**
 * 그룹 전체를 행에 적용한다.
 *
 * 규칙이 없으면 통과(필터 없음). and 는 전부, or 는 하나라도.
 * 존재하지 않는 propId 를 가리키는 규칙은 **무시한다** — 속성을 지웠다고 뷰가
 * 아무것도 안 보여주면 사용자는 이유를 알 수 없다.
 */
export function matchesGroup(
  props: Record<string, unknown>,
  properties: PropLike[],
  group: FilterGroup | null | undefined,
): boolean {
  if (!group || !group.rules.length) return true;
  const byId = new Map(properties.map((p) => [p.id, p]));

  const usable = group.rules.filter((r) => byId.has(r.propId));
  if (!usable.length) return true;

  const results = usable.map((r) => matchRule(props[r.propId], r, filterKindOf(byId.get(r.propId)!.type)));
  return group.conj === "or" ? results.some(Boolean) : results.every(Boolean);
}

/** 신뢰할 수 없는 입력에서 저장 가능한 그룹만 골라낸다(뷰 config 저장용). */
export function sanitizeFilterGroup(raw: unknown): FilterGroup | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { conj?: unknown; rules?: unknown };
  const conj = r.conj === "or" ? "or" : "and";
  if (!Array.isArray(r.rules)) return { conj, rules: [] };

  const ops = new Set<string>(Object.keys(OP_LABEL));
  const rules: FilterRule[] = [];
  for (const item of r.rules) {
    if (!item || typeof item !== "object") continue;
    const it = item as { propId?: unknown; op?: unknown; value?: unknown };
    if (typeof it.propId !== "string" || !it.propId) continue;
    if (typeof it.op !== "string" || !ops.has(it.op)) continue;
    const value =
      it.value == null ? null : typeof it.value === "number" || typeof it.value === "string" ? it.value : null;
    rules.push({ propId: it.propId, op: it.op as FilterOp, value });
  }
  return { conj, rules };
}
