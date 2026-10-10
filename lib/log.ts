/**
 * 구조화 로그(의존성 0 · 노드/엣지 공용 — node: import·process.stdout 없이 console 을 싱크로 쓴다).
 *
 *   log.warn("slack.post_failed", { msg: "슬랙 발송 실패", status: 500 })
 *   withReq(req).error("approvals.create_failed", { err: e })   // 모든 줄에 reqId
 *
 * 형식: LOG_FORMAT=json|pretty 로 강제, 없으면 NODE_ENV=production → json(한 줄), 그 외 pretty
 *   (pretty 는 Error 필드가 있으면 스택 앞 5줄을 다음 줄들에 붙인다).
 * 수준: LOG_LEVEL=debug|info|warn|error (대소문자 무시, 기본 info) — 그보다 낮은 수준은 출력하지 않는다.
 * 이벤트 이름은 `도메인.사건` 소문자 스네이크, 사람이 읽는 한국어 설명은 `msg` 필드에.
 * warn/error → console.error(stderr), debug/info → console.log(stdout).
 * 로거는 절대 throw 하지 않는다(로그 때문에 요청이 죽으면 안 된다).
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;
export type LogFormat = "json" | "pretty";

type LogFn = (event: string, f?: LogFields) => void;
export type Logger = { debug: LogFn; info: LogFn; warn: LogFn; error: LogFn };

const STACK_LINES = 5;
const RESERVED = new Set(["t", "level", "event"]);

type SerializedError = { name: string; message: string; code?: string | number; stack?: string; cause?: unknown };

const stackHead = (e: Error): string[] => (typeof e.stack === "string" ? e.stack.split("\n").slice(0, STACK_LINES) : []);

/** Error → {name,message,code?,stack?(앞 5줄),cause?}. code 는 문자열·숫자일 때만(Prisma P2002 등), cause 는 한 단계까지. */
function serializeError(e: Error, depth = 0): SerializedError {
  const out: SerializedError = { name: e.name, message: e.message };
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") out.code = code;
  const stack = stackHead(e);
  if (stack.length) out.stack = stack.join("\n");
  const cause = (e as { cause?: unknown }).cause;
  if (cause !== undefined && depth < 1) out.cause = cause instanceof Error ? serializeError(cause, depth + 1) : toJsonSafe(cause);
  return out;
}

/** JSON 으로 안전하게 바꿀 수 있는 값으로 — Error·순환·BigInt 처리, 그래도 실패하면 String(v). */
function toJsonSafe(v: unknown): unknown {
  if (v instanceof Error) return serializeError(v);
  if (v === null || (typeof v !== "object" && typeof v !== "bigint")) return v;
  try {
    const seen = new WeakSet<object>();
    const text = JSON.stringify(v, function (_k, val: unknown) {
      if (typeof val === "bigint") return val.toString();
      if (val instanceof Error) return serializeError(val);
      if (val !== null && typeof val === "object") {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return val;
    });
    return text === undefined ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return safeString(v);
  }
}

function safeString(v: unknown): string {
  try {
    return String(v);
  } catch {
    return "[Unserializable]";
  }
}

function prettyValue(v: unknown): string {
  if (v instanceof Error) {
    const code = (v as { code?: unknown }).code;
    const tag = typeof code === "string" || typeof code === "number" ? ` [${code}]` : "";
    return JSON.stringify(`${v.name}: ${v.message}${tag}`);
  }
  if (typeof v === "string") return /^[^\s"=]+$/.test(v) ? v : JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean" || v === null || v === undefined) return String(v);
  const safe = toJsonSafe(v);
  if (typeof safe === "string") return JSON.stringify(safe);
  try {
    return JSON.stringify(safe) ?? "undefined";
  } catch {
    return JSON.stringify(safeString(v));
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 한 줄 로그 문자열(순수). reqId 필드가 있으면 t·level·event 바로 뒤에 둔다. */
export function formatLine(level: LogLevel, event: string, fields: LogFields | undefined, opts: { format: LogFormat; now: Date }): string {
  const entries = Object.entries(fields ?? {}).filter(([k, v]) => !RESERVED.has(k) && v !== undefined);
  entries.sort(([a], [b]) => (a === "reqId" ? -1 : b === "reqId" ? 1 : 0));

  if (opts.format === "pretty") {
    const d = opts.now;
    const head = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${level.toUpperCase()} ${event}`;
    const line = [head, ...entries.map(([k, v]) => `${k}=${prettyValue(v)}`)].join(" ");
    // 개발 중 console.error(e) 가 보여 주던 스택을 잃지 않게 — Error 필드마다 스택 앞 5줄을 다음 줄들에
    const stacks = entries.flatMap(([, v]) => (v instanceof Error ? stackHead(v).map((l) => `    ${l.trim()}`) : []));
    return stacks.length ? [line, ...stacks].join("\n") : line;
  }

  const obj: Record<string, unknown> = { t: opts.now.toISOString(), level, event };
  for (const [k, v] of entries) obj[k] = toJsonSafe(v);
  try {
    return JSON.stringify(obj);
  } catch {
    // toJsonSafe 가 이미 걸렀으니 여기 올 일은 없지만, 로거는 throw 하지 않는다.
    return JSON.stringify({ t: obj.t, level, event, msg: "log.serialize_failed" });
  }
}

function currentFormat(): LogFormat {
  try {
    const env = typeof process !== "undefined" && process.env ? process.env : undefined;
    const forced = (env?.LOG_FORMAT ?? "").trim().toLowerCase();
    if (forced === "json" || forced === "pretty") return forced;
    return env?.NODE_ENV === "production" ? "json" : "pretty";
  } catch {
    return "json";
  }
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 출력할 최소 수준 — 없거나 알 수 없는 값은 info. */
export function currentLevel(): LogLevel {
  try {
    const v = (typeof process !== "undefined" && process.env ? process.env.LOG_LEVEL ?? "" : "").trim().toLowerCase();
    return v === "debug" || v === "info" || v === "warn" || v === "error" ? v : "info";
  } catch {
    return "info";
  }
}

function emit(level: LogLevel, event: string, fields: LogFields | undefined): void {
  try {
    if (LEVEL_RANK[level] < LEVEL_RANK[currentLevel()]) return;
    const line = formatLine(level, event, fields, { format: currentFormat(), now: new Date() });
    if (level === "warn" || level === "error") console.error(line);
    else console.log(line);
  } catch {
    /* 로거는 절대 throw 하지 않는다 */
  }
}

function makeLogger(base?: LogFields): Logger {
  const at = (level: LogLevel): LogFn => (event, f) => emit(level, event, base ? { ...base, ...f } : f);
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

export const log: Logger = makeLogger();

type HeaderSource = { headers: { get(n: string): string | null } };

/** 미들웨어가 넣은 x-request-id(없거나 빈 값이면 null). */
export function reqIdFrom(req: Request | HeaderSource): string | null {
  try {
    const v = req.headers.get("x-request-id");
    return v ? v : null;
  } catch {
    return null;
  }
}

/** 모든 줄에 reqId 를 섞어 넣는 바운드 로거(요청 id 가 없으면 평범한 log 와 같다). */
export function withReq(req: Request | HeaderSource): Logger {
  const reqId = reqIdFrom(req);
  return reqId ? makeLogger({ reqId }) : log;
}
