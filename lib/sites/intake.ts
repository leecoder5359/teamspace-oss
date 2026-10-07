/* =====================================================================
   인테이크 제출 본문의 순수 규칙 — 파싱·상한·제출 빈도 제한.

   서버는 폼의 생김새를 모른다. 페이지가 `{items:[{service, fields:[{label,value}]}]}`
   로 보내고, 서버는 service(이름표, 평문 저장)와 fields(통째로 암호화) 만 구분한다.
   덕분에 "항목 추가"로 임의의 행이 생겨도 스키마를 건드릴 일이 없다.

   값은 절대 로그·에러 메시지에 싣지 않는다 — 여기서 나가는 error 문자열은 전부
   값이 아니라 **규칙**만 말한다.
   ===================================================================== */

export const INTAKE_MAX_ITEMS = 40;
export const INTAKE_MAX_FIELDS = 24;
export const INTAKE_MAX_LABEL_CHARS = 120;
export const INTAKE_MAX_VALUE_CHARS = 4000;
/** 본문 상한. /pub 프록시가 1MB 에서 이미 413 을 내지만, upstream 도 스스로 막는다. */
export const INTAKE_MAX_BODY_BYTES = 256 * 1024;

export type IntakeField = { label: string; value: string };
export type IntakeItem = { service: string; fields: IntakeField[] };

export type ParseResult = { ok: true; items: IntakeItem[] } | { ok: false; error: string };

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** 제어문자 제거(로그 위조·표시 깨짐 방지). 줄바꿈·탭은 백업코드 때문에 남긴다. */
function stripControl(v: string): string {
  let out = "";
  for (const ch of v) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 && ch !== "\n" && ch !== "\t") continue;
    if (c === 0x7f) continue;
    out += ch;
  }
  return out;
}

/** 이름표(서비스명·라벨)는 다듬는다 — 표시용이고 공백이 의미를 갖지 않는다. */
const cleanLabel = (v: string): string => stripControl(v).replace(/[\n\t]+/g, " ").trim();

/**
 * 값은 **다듬지 않는다**. 앞뒤 공백이 있는 비밀번호를 조용히 바꿔 놓으면
 * 받는 쪽이 로그인에 실패하고 원인을 영원히 모른다. 공백만 있는 칸은 빈 칸으로 본다.
 */
function cleanValue(v: string): string {
  const s = stripControl(v);
  return s.trim() === "" ? "" : s;
}

export function parseIntakeSubmission(body: unknown): ParseResult {
  if (!body || typeof body !== "object") return { ok: false, error: "본문이 JSON 객체가 아닙니다." };
  const rawItems = (body as { items?: unknown }).items;
  if (!Array.isArray(rawItems)) return { ok: false, error: "items 배열이 필요합니다." };
  if (rawItems.length === 0) return { ok: false, error: "채워 넣은 항목이 없습니다." };
  if (rawItems.length > INTAKE_MAX_ITEMS) return { ok: false, error: `항목은 한 번에 ${INTAKE_MAX_ITEMS}개까지 보낼 수 있습니다.` };

  const items: IntakeItem[] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object") return { ok: false, error: "items 의 원소는 객체여야 합니다." };
    const r = raw as { service?: unknown; fields?: unknown };
    const service = cleanLabel(str(r.service));
    if (!service) return { ok: false, error: "각 항목에 service(서비스명)가 필요합니다." };
    if (service.length > INTAKE_MAX_LABEL_CHARS) {
      return { ok: false, error: `서비스명은 ${INTAKE_MAX_LABEL_CHARS}자까지입니다.` };
    }
    if (!Array.isArray(r.fields)) return { ok: false, error: `'${service}' 항목에 fields 배열이 필요합니다.` };
    if (r.fields.length > INTAKE_MAX_FIELDS) return { ok: false, error: `한 항목의 입력칸은 ${INTAKE_MAX_FIELDS}개까지입니다.` };

    const fields: IntakeField[] = [];
    for (const f of r.fields) {
      if (!f || typeof f !== "object") return { ok: false, error: "fields 의 원소는 객체여야 합니다." };
      const label = cleanLabel(str((f as { label?: unknown }).label));
      const value = cleanValue(str((f as { value?: unknown }).value));
      if (!label || !value) continue; // 빈 칸은 그냥 버린다(외주사가 모르는 칸을 비우는 게 정상)
      // 넘치면 **거절한다**. 잘라서 저장하면 게스트는 "저장됐습니다" 만 보고, 받는 쪽은
      // 끊긴 백업코드로 로그인을 시도하게 된다 — 조용한 손상이 가장 나쁘다.
      if (label.length > INTAKE_MAX_LABEL_CHARS) return { ok: false, error: `'${service}' 항목의 입력칸 이름이 ${INTAKE_MAX_LABEL_CHARS}자를 넘습니다.` };
      if (value.length > INTAKE_MAX_VALUE_CHARS) {
        return { ok: false, error: `'${service}' 의 '${label}' 칸이 ${INTAKE_MAX_VALUE_CHARS}자를 넘습니다. 나눠서 보내 주세요(값은 저장되지 않았습니다).` };
      }
      fields.push({ label, value });
    }
    // 아무것도 안 채운 행은 저장하지 않는다 — 프리필된 빈 행이 그대로 넘어오기 때문.
    if (fields.length) items.push({ service, fields });
  }
  if (items.length === 0) return { ok: false, error: "채워 넣은 값이 하나도 없습니다." };
  return { ok: true, items };
}

/* ── 제출 빈도 제한 ────────────────────────────────────────────────────────
   프로세스 메모리 기준(단일 노드 배포라 충분하다). 게스트 한 명이 같은 사이트에
   폭주 제출하는 것만 막으면 된다 — 정상 제출은 몇 번이면 끝난다. */

export const INTAKE_RATE_LIMIT = 12;
export const INTAKE_RATE_WINDOW_MS = 10 * 60 * 1000;

export type RateState = Map<string, number[]>;

export function rateKey(siteId: string, email: string): string {
  return `${siteId}\n${email}`;
}

/** 창 안 제출 수가 상한 미만이면 기록하고 true. 상한이면 아무것도 기록하지 않고 false. */
export function allowSubmission(
  state: RateState,
  key: string,
  now = Date.now(),
  limit = INTAKE_RATE_LIMIT,
  windowMs = INTAKE_RATE_WINDOW_MS,
): boolean {
  const kept = (state.get(key) ?? []).filter((t) => now - t < windowMs);
  if (kept.length >= limit) {
    state.set(key, kept);
    return false;
  }
  kept.push(now);
  state.set(key, kept);
  // 오래된 키가 무한정 쌓이지 않게(게스트 수는 적지만 사이트는 계속 는다).
  if (state.size > 500) {
    for (const [k, v] of state) if (v.every((t) => now - t >= windowMs)) state.delete(k);
  }
  return true;
}
