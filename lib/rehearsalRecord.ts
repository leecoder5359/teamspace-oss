/**
 * 백업 복원 리허설 기록(3단계 후속) — `pnpm restore:rehearsal` 출력에서 TeamSpace 문서용 블록을 뽑고,
 * 분기 리마인더 날짜(1·4·7·10월 첫 월요일)를 판정한다. 순수 함수만 둔다(CLI·워커가 쓴다).
 */
export const REHEARSAL_MARKER = "---- TeamSpace 문서용 ----";
const HEADING = /^###\s*백업 복원 리허설\s+(\d{4}-\d{2}-\d{2})\s*$/;

export type RehearsalBlock = { title: string; date: string; result: "PASS" | "FAIL" | null; markdown: string };

/**
 * 출력 전문에서 마지막 문서용 블록을 꺼낸다. 블록 첫 줄(### 제목)은 문서 제목으로 옮기고 본문에서 뺀다.
 * 블록이 없으면 null. 제목 줄에 날짜가 없으면 fallbackDate 를 쓴다.
 */
export function extractRehearsalBlock(output: string, fallbackDate: string): RehearsalBlock | null {
  const text = output.replace(/\r\n/g, "\n");
  const at = text.lastIndexOf(REHEARSAL_MARKER);
  if (at < 0) return null;
  const lines = text.slice(at + REHEARSAL_MARKER.length).split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  let date = fallbackDate;
  const m = lines.length ? HEADING.exec(lines[0].trim()) : null;
  if (m) {
    date = m[1];
    lines.shift();
  }
  // 목록이 끝나는 곳(제목 뒤 첫 비목록·비공백 줄, 또는 '결과:' 줄)에서 멈춘다 — tee 로 받은 pnpm/셸 꼬리가 문서에 들어가지 않게.
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t && !/^[-*+]\s/.test(t)) break;
    kept.push(line);
    if (/^[-*+]\s+결과:\s*\*\*(PASS|FAIL)\*\*/.test(t)) break;
  }
  const body = kept.join("\n").trim();
  if (!body) return null;
  const r = /결과:\s*\*\*(PASS|FAIL)\*\*/.exec(body);
  return { title: `백업 복원 리허설 ${date}`, date, result: (r?.[1] as "PASS" | "FAIL" | undefined) ?? null, markdown: body + "\n" };
}

/** 로컬 날짜가 분기 리허설 리마인더 날인가 — 1·4·7·10월의 첫 월요일(1~7일 중 월요일). */
export function isQuarterlyRehearsalDay(now: Date): boolean {
  return [0, 3, 6, 9].includes(now.getMonth()) && now.getDay() === 1 && now.getDate() <= 7;
}

/** 리마인더 발송 창 — 그날 09:00~09:59(로컬). 주간 다이제스트의 inDigestWindow 와 같은 방식. */
export function inRehearsalWindow(now: Date): boolean {
  return isQuarterlyRehearsalDay(now) && now.getHours() === 9;
}

/** 그 분기 리마인더의 1회 표식 키(NotifLog). 예: 2026-Q4 */
export function rehearsalQuarterKey(now: Date): string {
  return `${now.getFullYear()}-Q${Math.floor(now.getMonth() / 3) + 1}`;
}
