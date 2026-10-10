/* =====================================================================
   AI 실행 경로 — 외부 LLM 중계 서버(relay) 상태·사용량 (읽기 전용).

   TeamSpace 는 중계 비밀을 갖지 않는다. 그래서
   - 생존은 비인증 health 호출의 401/200 으로만 판정하고,
   - 사용량은 중계가 남기는 JSON 줄 로그를 서버에서 직접 읽어 집계한다.
   로그는 회전되지 않으므로 끝에서부터 최대 RELAY_LOG_TAIL_BYTES 만 읽는다.

   경로·라벨은 전부 env 로 받는다(OSS 이식성). 비어 있으면 "설정 안 됨".
     AI_RELAY_LOG_PATH       중계 JSON 줄 로그
     AI_RELAY_HEALTH_URL     비인증 health URL (401/200 = 살아 있음)
     AI_RELAY_LAUNCHD_LABEL  launchd 라벨 (macOS — launchctl list)
     AI_RELAY_WATCHDOG_LOG   공개 입구 감시 로그 (`[funnel <ts>] ok|fail …`)
     AI_RELAY_DEPLOY_DIR     배포 폴더 (`current` 심볼릭 링크 대상 이름 = 배포본)
     AI_RELAY_LABEL          사용처 표에 보일 이름 (기본 "AI 중계 서버")

   파싱·집계는 순수 함수(테스트: relay.test.ts), 입출력은 아래쪽 함수들.
   ===================================================================== */

import { execFile } from "node:child_process";
import { open, readlink, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const RELAY_LOG_TAIL_BYTES = 8 * 1024 * 1024;
export const MAX_DAYS = 30;
export const DEFAULT_DAYS = 7;

/* ── 설정 ─────────────────────────────────────────────────────────────── */

export type RelayConfig = {
  logPath: string | null;
  healthUrl: string | null;
  launchdLabel: string | null;
  watchdogLog: string | null;
  deployDir: string | null;
  label: string;
};

export function expandHome(p: string, home = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

export function relayConfig(env: Record<string, string | undefined> = process.env, home = homedir()): RelayConfig {
  const v = (k: string) => {
    const s = (env[k] ?? "").trim();
    return s ? s : null;
  };
  const path = (k: string) => {
    const s = v(k);
    return s ? expandHome(s, home) : null;
  };
  return {
    logPath: path("AI_RELAY_LOG_PATH"),
    healthUrl: v("AI_RELAY_HEALTH_URL"),
    launchdLabel: v("AI_RELAY_LAUNCHD_LABEL"),
    watchdogLog: path("AI_RELAY_WATCHDOG_LOG"),
    deployDir: path("AI_RELAY_DEPLOY_DIR"),
    label: v("AI_RELAY_LABEL") ?? "AI 중계 서버",
  };
}

/** 로그나 health 중 하나라도 있으면 중계 구역을 보인다. */
export function isRelayConfigured(c: RelayConfig): boolean {
  return !!(c.logPath || c.healthUrl);
}

/** 기간 파라미터: 기본 7, 1~30 으로 자른다. */
export function clampDays(raw: string | number | null | undefined): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, n);
}

/* ── 날짜 키 ──────────────────────────────────────────────────────────── */

/** Date → "YYYY-MM-DD" (tz 미지정 = 서버 로컬 시간대). */
export function dayKey(d: Date, tz?: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** 오늘을 포함한 최근 N 일의 날짜 키(오래된 → 최근). */
export function recentDayKeys(days: number, now: Date, tz?: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  // 하루씩 빼되 DST 같은 경계에서도 중복·누락이 없도록 키로 거른다
  for (let i = 0; keys.length < days && i < days + 3; i++) {
    const k = dayKey(new Date(now.getTime() - i * 86_400_000), tz);
    if (!seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  }
  return keys.reverse();
}

/* ── 로그 줄 파싱 ─────────────────────────────────────────────────────── */

export type RelayRequest = {
  kind: "request";
  at: Date;
  method: string;
  path: string;
  status: number;
  code: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
};
export type RelayListening = { kind: "listening"; at: Date; models: string[]; defaultModel: string | null; rotating: boolean | null };
export type RelayLine = RelayRequest | RelayListening;

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const str = (x: unknown): string | null => (typeof x === "string" ? x : null);

/** JSON 줄 하나 → 요청/시작 이벤트. 깨진 줄·모르는 모양은 null. */
export function parseRelayLine(line: string): RelayLine | null {
  const t = line.trim();
  if (!t || t[0] !== "{") return null;
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(t);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    o = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const atStr = str(o.at);
  const at = atStr ? new Date(atStr) : null;
  if (!at || Number.isNaN(at.getTime())) return null;

  if (o.event === "listening") {
    // 초기 형식은 models 대신 model 하나만 남겼다
    const models = Array.isArray(o.models)
      ? o.models.filter((m): m is string => typeof m === "string")
      : str(o.model)
        ? [o.model as string]
        : [];
    return {
      kind: "listening",
      at,
      models,
      defaultModel: str(o.defaultModel) ?? str(o.model),
      rotating: typeof o.rotating === "boolean" ? o.rotating : null,
    };
  }
  if (typeof o.event === "string") return null;

  const path = str(o.path);
  const code = str(o.code);
  const status = num(o.status);
  if (!path || !code || status === null) return null;
  return {
    kind: "request",
    at,
    method: str(o.method) ?? "",
    path,
    status,
    code,
    durationMs: num(o.durationMs) ?? 0,
    inputTokens: num(o.inputTokens),
    outputTokens: num(o.outputTokens),
  };
}

/** 생존 확인 줄(…/health, …/healthz) — 사용량에서 빼고 따로 센다. */
export function isHealthPath(path: string): boolean {
  return /\/health[z]?\/?$/.test(path.split("?")[0]);
}

/** 실제 사용량 = POST …/complete 만. 접두만 두드린 요청·없는 경로·다른 메서드는 '기타 요청' 으로 따로 센다. */
export function isUsageRequest(method: string, path: string): boolean {
  return method.toUpperCase() === "POST" && /\/complete\/?$/.test(path.split("?")[0]);
}

/* ── 집계 ─────────────────────────────────────────────────────────────── */

export type RelayDay = {
  day: string;
  calls: number;
  ok: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  avgMs: number | null;
  p95Ms: number | null;
};
export type RelayFailure = { at: string; method: string; path: string; status: number; code: string; durationMs: number };
export type RelayUsage = {
  days: number;
  byDay: RelayDay[];
  totals: Omit<RelayDay, "day"> & { okRate: number | null; healthChecks: number; otherRequests: number };
  failureCodes: { code: string; count: number }[];
  recentFailures: RelayFailure[];
  lastListening: { at: string; models: string[]; defaultModel: string | null; rotating: boolean | null } | null;
  badLines: number;
};

export function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
}
const avg = (values: number[]) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);

/**
 * 로그 줄들 → 기간 사용량. 대상은 POST …/complete 줄뿐(health·기타 요청은 따로 센다). 실패 = code 가 ok 가 아닌 것.
 * 마지막 listening 이벤트는 기간과 무관하게 가장 최근 것(허용 모델 표시용).
 */
export function aggregateRelay(lines: Iterable<string>, opts: { days: number; now: Date; tz?: string }): RelayUsage {
  const keys = recentDayKeys(opts.days, opts.now, opts.tz);
  const inWindow = new Set(keys);
  const buckets = new Map<string, { calls: number; ok: number; inT: number; outT: number; durs: number[] }>();
  for (const k of keys) buckets.set(k, { calls: 0, ok: 0, inT: 0, outT: 0, durs: [] });
  const codes = new Map<string, number>();
  const failures: RelayFailure[] = [];
  let health = 0;
  let other = 0;
  let bad = 0;
  let lastListening: RelayListening | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    const r = parseRelayLine(line);
    if (!r) {
      bad++;
      continue;
    }
    if (r.kind === "listening") {
      if (!lastListening || r.at >= lastListening.at) lastListening = r;
      continue;
    }
    const k = dayKey(r.at, opts.tz);
    if (!inWindow.has(k)) continue;
    if (isHealthPath(r.path)) {
      health++;
      continue;
    }
    if (!isUsageRequest(r.method, r.path)) {
      other++;
      continue;
    }
    const b = buckets.get(k)!;
    b.calls++;
    b.durs.push(r.durationMs);
    b.inT += r.inputTokens ?? 0;
    b.outT += r.outputTokens ?? 0;
    if (r.code === "ok") b.ok++;
    else {
      codes.set(r.code, (codes.get(r.code) ?? 0) + 1);
      failures.push({ at: r.at.toISOString(), method: r.method, path: r.path, status: r.status, code: r.code, durationMs: r.durationMs });
    }
  }

  const byDay: RelayDay[] = keys.map((day) => {
    const b = buckets.get(day)!;
    return { day, calls: b.calls, ok: b.ok, failed: b.calls - b.ok, inputTokens: b.inT, outputTokens: b.outT, avgMs: avg(b.durs), p95Ms: p95(b.durs) };
  });
  const allDurs = keys.flatMap((k) => buckets.get(k)!.durs);
  const calls = byDay.reduce((a, d) => a + d.calls, 0);
  const ok = byDay.reduce((a, d) => a + d.ok, 0);
  return {
    days: opts.days,
    byDay,
    totals: {
      calls,
      ok,
      failed: calls - ok,
      okRate: calls ? ok / calls : null,
      inputTokens: byDay.reduce((a, d) => a + d.inputTokens, 0),
      outputTokens: byDay.reduce((a, d) => a + d.outputTokens, 0),
      avgMs: avg(allDurs),
      p95Ms: p95(allDurs),
      healthChecks: health,
      otherRequests: other,
    },
    failureCodes: [...codes.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    recentFailures: failures.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10),
    lastListening: lastListening
      ? { at: lastListening.at.toISOString(), models: lastListening.models, defaultModel: lastListening.defaultModel, rotating: lastListening.rotating }
      : null,
    badLines: bad,
  };
}

/** `launchctl list` 출력(PID\tStatus\tLabel)에서 라벨 한 줄. 없으면 null. */
export function parseLaunchctlList(stdout: string, label: string): { pid: number | null; lastExitStatus: number | null } | null {
  for (const line of stdout.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3 || cols[2] !== label) continue;
    const pid = /^\d+$/.test(cols[0]) ? Number(cols[0]) : null;
    const st = /^-?\d+$/.test(cols[1]) ? Number(cols[1]) : null;
    return { pid, lastExitStatus: st };
  }
  return null;
}

/** 감시 로그 마지막 줄 → { at, ok, text }. `[funnel <ts>] ok` / `[funnel <ts>] fail #n (…)` */
export function parseWatchdogTail(text: string): { at: string | null; ok: boolean; text: string } | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return null;
  const m = /^\[[^\s\]]+\s+([^\]]+)\]\s*(.*)$/.exec(last);
  const body = (m ? m[2] : last).trim();
  return { at: m ? m[1] : null, ok: /^ok\b/i.test(body), text: body.slice(0, 200) };
}

/** 살아 있음 판정: 비인증 health 가 401(인증 필요) 이나 200 이면 프로세스가 응답 중이다. */
export function interpretHealthStatus(status: number): "alive" | "unexpected" {
  return status === 401 || status === 200 ? "alive" : "unexpected";
}

/* ── 입출력 ───────────────────────────────────────────────────────────── */

/** 파일 끝에서 최대 maxBytes 읽기. 중간에서 잘렸으면 첫 (부분) 줄은 버린다. */
export async function readTail(path: string, maxBytes = RELAY_LOG_TAIL_BYTES): Promise<{ text: string; size: number; truncated: boolean }> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    let read = 0;
    while (read < len) {
      const { bytesRead } = await fh.read(buf, read, len - read, start + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    let text = buf.subarray(0, read).toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    }
    return { text, size, truncated: start > 0 };
  } finally {
    await fh.close();
  }
}

export type RelayStatus = {
  process: { state: "running" | "stopped" | "missing" | "unavailable" | "not_configured"; pid: number | null; lastExitStatus: number | null };
  health: { state: "alive" | "down" | "unexpected" | "not_configured"; httpStatus: number | null; error: string | null; ms: number | null };
  watchdog: { state: "ok" | "fail" | "empty" | "unavailable" | "not_configured"; at: string | null; text: string | null };
  deploy: { state: "ok" | "unavailable" | "not_configured"; version: string | null };
  models: { list: string[]; defaultModel: string | null; since: string | null };
};

async function processStatus(label: string | null): Promise<RelayStatus["process"]> {
  if (!label) return { state: "not_configured", pid: null, lastExitStatus: null };
  try {
    const { stdout } = await execFileP("launchctl", ["list"], { timeout: 3000, maxBuffer: 2 * 1024 * 1024 });
    const row = parseLaunchctlList(stdout, label);
    if (!row) return { state: "missing", pid: null, lastExitStatus: null };
    return { state: row.pid ? "running" : "stopped", pid: row.pid, lastExitStatus: row.lastExitStatus };
  } catch {
    // launchctl 이 없는 OS(리눅스 등)·타임아웃
    return { state: "unavailable", pid: null, lastExitStatus: null };
  }
}

async function healthStatus(url: string | null): Promise<RelayStatus["health"]> {
  if (!url) return { state: "not_configured", httpStatus: null, error: null, ms: null };
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(3000), cache: "no-store", redirect: "manual" });
    await res.body?.cancel().catch(() => {});
    return { state: interpretHealthStatus(res.status), httpStatus: res.status, error: null, ms: Date.now() - t0 };
  } catch (e) {
    const cause = (e as { cause?: { code?: string } })?.cause?.code;
    const name = (e as { name?: string })?.name;
    const error = name === "TimeoutError" || name === "AbortError" ? "timeout" : cause === "ECONNREFUSED" ? "connection_refused" : cause ?? "error";
    return { state: "down", httpStatus: null, error, ms: Date.now() - t0 };
  }
}

async function watchdogStatus(path: string | null): Promise<RelayStatus["watchdog"]> {
  if (!path) return { state: "not_configured", at: null, text: null };
  try {
    const { text } = await readTail(path, 16 * 1024);
    const last = parseWatchdogTail(text);
    if (!last) return { state: "empty", at: null, text: null };
    return { state: last.ok ? "ok" : "fail", at: last.at, text: last.text };
  } catch {
    return { state: "unavailable", at: null, text: null };
  }
}

async function deployStatus(dir: string | null): Promise<RelayStatus["deploy"]> {
  if (!dir) return { state: "not_configured", version: null };
  for (const p of [join(dir, "current"), dir]) {
    try {
      return { state: "ok", version: basename(await readlink(p)) };
    } catch {
      /* 다음 후보 */
    }
  }
  try {
    await stat(dir);
    return { state: "ok", version: basename(dir) };
  } catch {
    return { state: "unavailable", version: null };
  }
}

export type RelayReport = {
  configured: boolean;
  label: string;
  status: RelayStatus | null;
  usage: (RelayUsage & { log: { size: number; scannedBytes: number; truncated: boolean } }) | null;
  usageError: string | null;
};

/** 중계 상태 + 기간 사용량. 설정이 비면 configured:false 만. 어떤 실패도 throw 하지 않는다. */
export async function getRelayReport(days: number, opts: { now?: Date; tz?: string; config?: RelayConfig } = {}): Promise<RelayReport> {
  const cfg = opts.config ?? relayConfig();
  if (!isRelayConfigured(cfg)) return { configured: false, label: cfg.label, status: null, usage: null, usageError: null };
  const now = opts.now ?? new Date();

  const usageP = (async () => {
    if (!cfg.logPath) return { usage: null, usageError: "not_configured" };
    try {
      const { text, size, truncated } = await readTail(cfg.logPath);
      const u = aggregateRelay(text.split("\n"), { days, now, tz: opts.tz });
      return { usage: { ...u, log: { size, scannedBytes: Buffer.byteLength(text), truncated } }, usageError: null };
    } catch (e) {
      return { usage: null, usageError: (e as { code?: string })?.code === "ENOENT" ? "log_missing" : "log_unreadable" };
    }
  })();
  const [proc, health, watchdog, deploy, u] = await Promise.all([
    processStatus(cfg.launchdLabel),
    healthStatus(cfg.healthUrl),
    watchdogStatus(cfg.watchdogLog),
    deployStatus(cfg.deployDir),
    usageP,
  ]);
  const ll = u.usage?.lastListening ?? null;
  return {
    configured: true,
    label: cfg.label,
    status: {
      process: proc,
      health,
      watchdog,
      deploy,
      models: { list: ll?.models ?? [], defaultModel: ll?.defaultModel ?? null, since: ll?.at ?? null },
    },
    usage: u.usage,
    usageError: u.usageError,
  };
}
