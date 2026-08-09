/* =====================================================================
   뷰 배치 계산 (격차 C1: 달력·타임라인) — 순수 함수. React 도 prisma 도 모른다.

   달력과 타임라인은 "어느 칸에 무엇이 들어가나" 가 전부인데, 그 계산이 컴포넌트
   안에 있으면 눈으로만 확인하게 된다(윤년·월말·주 경계는 눈으로 못 잡는다).

   **시간대 변환을 하지 않는다.** 저장된 값의 날짜 부분을 문자열로 읽고 문자열로
   비교한다. `new Date("2026-08-09")` 는 UTC 자정으로 해석되므로 한국에서 그리면
   전날로 밀린다 — 로요에서 그 부류(KST 감사)로 크게 데인 적이 있다. 여기서는
   Date 를 **UTC 산술 용도로만** 쓰고, 표시용 문자열은 직접 만든다.
   ===================================================================== */

export type DayCell = { date: string; inMonth: boolean; isToday: boolean };
export type Span = { start: string; end: string };
export type Bounds = { min: string; max: string };

const DAY_MS = 86_400_000;

const pad = (n: number) => String(n).padStart(2, "0");

/** UTC 기준 Date → "YYYY-MM-DD" */
function keyOf(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** "YYYY-MM-DD" → UTC Date (시간대 영향 없음) */
function dateOf(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

/**
 * 달력 격자. 필요한 주 수만 만든다(빈 뒷줄을 만들지 않는다).
 *
 * @param month  1~12
 * @param weekStartsOn 0=일요일(기본), 1=월요일
 * @param today  "오늘" 로 표시할 날짜. **호출자가 넘긴다** — 모듈이 시계를 읽으면
 *               테스트가 날짜에 따라 흔들린다.
 */
export function monthGrid(year: number, month: number, weekStartsOn: 0 | 1 = 0, today?: string): DayCell[][] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lead = (first.getUTCDay() - weekStartsOn + 7) % 7;
  const weeks = Math.ceil((lead + daysInMonth) / 7);

  const out: DayCell[][] = [];
  let cursor = first.getTime() - lead * DAY_MS;
  for (let w = 0; w < weeks; w++) {
    const row: DayCell[] = [];
    for (let d = 0; d < 7; d++) {
      const cur = new Date(cursor);
      const date = keyOf(cur);
      row.push({
        date,
        inMonth: cur.getUTCFullYear() === year && cur.getUTCMonth() === month - 1,
        isToday: today === date,
      });
      cursor += DAY_MS;
    }
    out.push(row);
  }
  return out;
}

/** 달 이동(연도 넘김 포함). month 는 1~12. */
export function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const zero = year * 12 + (month - 1) + delta;
  return { year: Math.floor(zero / 12), month: (((zero % 12) + 12) % 12) + 1 };
}

export function monthLabel(year: number, month: number): string {
  return `${year}년 ${month}월`;
}

/**
 * 속성 값에서 날짜 키를 뽑는다. ISO 든 "YYYY-MM-DD" 든 **앞 10글자**를 쓴다.
 * 실제로 존재하는 날짜인지까지 확인한다(2026-02-30 같은 값은 버린다).
 */
export function toDateKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const dt = new Date(`${y}-${mo}-${d}T00:00:00.000Z`);
  if (Number.isNaN(dt.getTime())) return null;
  // 롤오버 검증: 2026-02-30 은 3월 2일이 되어 버린다
  return keyOf(dt) === `${y}-${mo}-${d}` ? `${y}-${mo}-${d}` : null;
}

/** 날짜별로 묶는다. 날짜가 없는 항목은 버린다(달력에 놓을 자리가 없다). */
export function bucketByDay<T>(items: T[], getDate: (item: T) => unknown): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const key = toDateKey(getDate(item));
    if (!key) continue;
    const list = out.get(key);
    if (list) list.push(item);
    else out.set(key, [item]);
  }
  return out;
}

/**
 * 한 행의 기간. 시작이 없으면 막대가 없다(null). 종료가 없으면 하루짜리.
 * 뒤집힌 입력은 바로잡는다 — 사용자가 실수해도 막대는 그려져야 고칠 수 있다.
 */
export function spanOf(startValue: unknown, endValue: unknown): Span | null {
  const start = toDateKey(startValue);
  if (!start) return null;
  const end = toDateKey(endValue) ?? start;
  return end < start ? { start: end, end: start } : { start, end };
}

export function boundsOf(spans: Span[]): Bounds | null {
  if (spans.length === 0) return null;
  let min = spans[0].start;
  let max = spans[0].end;
  for (const s of spans) {
    if (s.start < min) min = s.start;
    if (s.end > max) max = s.end;
  }
  return { min, max };
}

/**
 * 막대의 좌표(백분율). 끝나는 날을 **포함**하므로 하루짜리도 폭이 남는다
 * (폭 0 인 막대는 화면에서 사라져 "일정이 없는 것" 처럼 보인다).
 * 범위를 벗어나면 잘라 넣는다.
 */
export function barMetrics(span: Span, bounds: Bounds): { leftPct: number; widthPct: number } {
  const min = dateOf(bounds.min).getTime();
  const max = dateOf(bounds.max).getTime();
  const totalDays = Math.max(1, (max - min) / DAY_MS + 1);

  const startDay = (dateOf(span.start).getTime() - min) / DAY_MS;
  const endDay = (dateOf(span.end).getTime() - min) / DAY_MS;

  const from = Math.max(0, startDay);
  const to = Math.min(totalDays, endDay + 1);
  const leftPct = (from / totalDays) * 100;
  const widthPct = Math.max(0, ((to - from) / totalDays) * 100);
  return { leftPct, widthPct };
}
