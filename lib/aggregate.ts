/* =====================================================================
   열 집계 (격차 C6) — 순수 함수.

   표 아래 "합계 11 / 평균 2.75" 한 줄이 없으면, 숫자 열을 넣어 놓고도 매번
   눈으로 더하거나 CSV 로 내보내게 된다. 칸반에서도 열마다 개수만 있고 합계가
   없어서 "이 컬럼의 남은 공수" 같은 걸 못 봤다.

   설계에서 정한 두 가지:
   - **평균은 값이 있는 것만 나눈다.** 빈칸을 0 점으로 세면 평균이 조용히 낮아진다.
   - **값이 하나도 없으면 0 이 아니라 null.** "합이 0" 과 "값이 없음" 은 다르다.
   ===================================================================== */

export type AggFn =
  | "none"
  | "count"
  | "filled"
  | "empty"
  | "unique"
  | "sum"
  | "avg"
  | "min"
  | "max"
  | "checked"
  | "unchecked"
  | "percentChecked"
  | "earliest"
  | "latest";

/** 저장·검증에 쓰는 전체 목록. 라우트(sanitizeViewConfig)가 이걸 가져다 쓴다 —
 *  목록을 두 곳에 두면 반드시 어긋난다. */
export const AGG_FNS = [
  "none", "count", "filled", "empty", "unique", "sum", "avg", "min", "max",
  "checked", "unchecked", "percentChecked", "earliest", "latest",
] as const satisfies readonly AggFn[];

export const AGG_LABEL: Record<AggFn, string> = {
  none: "없음",
  count: "행 수",
  filled: "채워짐",
  empty: "비어 있음",
  unique: "고유값",
  sum: "합계",
  avg: "평균",
  min: "최소",
  max: "최대",
  checked: "체크됨",
  unchecked: "체크 안 됨",
  percentChecked: "체크 비율",
  earliest: "가장 이른",
  latest: "가장 늦은",
};

const COMMON: AggFn[] = ["none", "count", "filled", "empty"];

/** 이 속성 타입에서 의미가 있는 집계만. (체크박스에 '합계'를 주면 안 된다) */
export function aggOptionsFor(type: string): AggFn[] {
  switch (type) {
    case "number":
      return [...COMMON, "sum", "avg", "min", "max"];
    case "checkbox":
      return [...COMMON, "checked", "unchecked", "percentChecked"];
    case "date":
      return [...COMMON, "earliest", "latest"];
    default:
      return [...COMMON, "unique"];
  }
}

/** 값이 '있다'고 볼 것인가. 0 과 false 는 값이다 — 빈 문자열·null·빈 배열은 아니다. */
function isFilled(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** 숫자로 읽을 수 있으면 숫자로. 문자열로 저장된 입력도 받는다. */
function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 날짜 문자열의 앞 10글자. 시간대 변환은 하지 않는다(lib/viewLayout 과 같은 태도). */
function dateKey(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v.trim());
  return m ? m[1] : null;
}

/** 집계 결과. 계산할 게 없으면 null(0 과 구분한다). */
export function computeAgg(fn: AggFn, values: unknown[]): number | string | null {
  switch (fn) {
    case "none":
      return null;
    case "count":
      return values.length;
    case "filled":
      return values.filter(isFilled).length;
    case "empty":
      return values.filter((v) => !isFilled(v)).length;
    case "unique":
      return new Set(values.filter(isFilled).map((v) => JSON.stringify(v))).size;
    case "checked":
      return values.filter((v) => v === true).length;
    case "unchecked":
      return values.filter((v) => v !== true).length;
    case "percentChecked": {
      if (values.length === 0) return null;
      return Math.round((values.filter((v) => v === true).length / values.length) * 100);
    }
    case "sum":
    case "avg":
    case "min":
    case "max": {
      const nums = values.map(num).filter((n): n is number => n !== null);
      if (nums.length === 0) return null;
      if (fn === "sum") return nums.reduce((a, b) => a + b, 0);
      // 평균은 **값이 있는 것만** 나눈다 — 빈칸을 0 으로 세면 조용히 낮아진다.
      if (fn === "avg") return nums.reduce((a, b) => a + b, 0) / nums.length;
      return fn === "min" ? Math.min(...nums) : Math.max(...nums);
    }
    case "earliest":
    case "latest": {
      const keys = values.map(dateKey).filter((k): k is string => k !== null);
      if (keys.length === 0) return null;
      return fn === "earliest" ? keys.reduce((a, b) => (b < a ? b : a)) : keys.reduce((a, b) => (b > a ? b : a));
    }
  }
}

/** 화면 표기: "합계 1,234" / "평균 2.75" / "체크 비율 50%" / 값 없으면 "—". */
export function formatAgg(fn: AggFn, value: number | string | null): string {
  if (fn === "none") return "";
  if (value === null) return "—";
  let text: string;
  if (typeof value === "number") {
    // 평균만 소수점을 남긴다(나머지는 개수·합계라 정수).
    const rounded = fn === "avg" ? Math.round(value * 100) / 100 : value;
    text = rounded.toLocaleString("ko-KR");
  } else {
    text = value;
  }
  return `${AGG_LABEL[fn]} ${text}${fn === "percentChecked" ? "%" : ""}`;
}
