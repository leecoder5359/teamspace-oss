import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateRelay,
  clampDays,
  expandHome,
  interpretHealthStatus,
  isHealthPath,
  isUsageRequest,
  isRelayConfigured,
  p95,
  parseLaunchctlList,
  parseRelayLine,
  parseWatchdogTail,
  readTail,
  recentDayKeys,
  relayConfig,
} from "./relay";

const TZ = "Asia/Seoul";
const NOW = new Date("2026-10-08T12:00:00Z"); // KST 10-08 21:00

const L = (o: Record<string, unknown>) => JSON.stringify(o);
const FIXTURE = [
  L({ at: "2026-10-04T13:36:33.315Z", event: "listening", host: "127.0.0.1", port: 4719, prefix: "/r", provider: "claude-cli", model: "sonnet" }),
  L({ at: "2026-10-06T14:57:41.130Z", event: "listening", prefix: "/r", models: ["gpt:a", "sonnet"], defaultModel: "gpt:a", rotating: false }),
  L({ at: "2026-10-07T01:00:00.000Z", method: "GET", path: "/r/health", status: 401, code: "unauthorized", durationMs: 2 }),
  L({ at: "2026-10-07T02:00:00.000Z", method: "POST", path: "/r/complete", status: 200, code: "ok", durationMs: 1000, inputTokens: 100, outputTokens: 10 }),
  L({ at: "2026-10-07T03:00:00.000Z", method: "POST", path: "/r/complete", status: 200, code: "ok", durationMs: 3000, inputTokens: 200, outputTokens: 20 }),
  L({ at: "2026-10-08T03:00:00.000Z", method: "POST", path: "/r/complete", status: 502, code: "failed", durationMs: 500 }),
  L({ at: "2026-10-08T04:00:00.000Z", method: "POST", path: "/r/complete", status: 400, code: "model_not_allowed", durationMs: 1 }),
  L({ at: "2026-10-08T05:00:00.000Z", method: "GET", path: "/r/healthz", status: 404, code: "not_found", durationMs: 0 }),
  "{not json",
  "plain text line",
  L({ at: "2026-09-01T00:00:00.000Z", method: "POST", path: "/r/complete", status: 200, code: "ok", durationMs: 9, inputTokens: 9, outputTokens: 9 }),
  "",
];

describe("parseRelayLine", () => {
  it("요청 줄을 읽는다(토큰 없으면 null)", () => {
    const r = parseRelayLine(FIXTURE[5]);
    expect(r).toMatchObject({ kind: "request", path: "/r/complete", status: 502, code: "failed", durationMs: 500, inputTokens: null });
  });
  it("listening — models 배열, 초기 형식(model 하나)도", () => {
    expect(parseRelayLine(FIXTURE[1])).toMatchObject({ kind: "listening", models: ["gpt:a", "sonnet"], defaultModel: "gpt:a", rotating: false });
    expect(parseRelayLine(FIXTURE[0])).toMatchObject({ kind: "listening", models: ["sonnet"], defaultModel: "sonnet", rotating: null });
  });
  it("깨진 줄·배열·날짜 없음·필드 누락은 null", () => {
    expect(parseRelayLine("{not json")).toBeNull();
    expect(parseRelayLine("[1,2]")).toBeNull();
    expect(parseRelayLine(L({ path: "/x", status: 200, code: "ok" }))).toBeNull();
    expect(parseRelayLine(L({ at: "2026-10-08T00:00:00Z", path: "/x", code: "ok" }))).toBeNull();
    expect(parseRelayLine(L({ at: "2026-10-08T00:00:00Z", event: "shutdown" }))).toBeNull();
  });
});

describe("isHealthPath", () => {
  it("health·healthz 만", () => {
    expect(isHealthPath("/r/health")).toBe(true);
    expect(isHealthPath("/r/healthz")).toBe(true);
    expect(isHealthPath("/health?x=1")).toBe(true);
    expect(isHealthPath("/r/complete")).toBe(false);
    expect(isHealthPath("/r/healthy-check")).toBe(false);
  });
});

describe("isUsageRequest", () => {
  it("POST …/complete 만 사용량", () => {
    expect(isUsageRequest("POST", "/r/complete")).toBe(true);
    expect(isUsageRequest("post", "/r/complete?x=1")).toBe(true);
    expect(isUsageRequest("GET", "/r/complete")).toBe(false);
    expect(isUsageRequest("POST", "/r")).toBe(false);
    expect(isUsageRequest("POST", "/r/completely")).toBe(false);
  });
});

describe("aggregateRelay — 기타 요청 분리", () => {
  it("접두만 두드림·not_found 탐색·다른 메서드는 호출·실패에서 빼고 otherRequests 로 센다", () => {
    const lines = [
      L({ at: "2026-10-07T13:39:00.000Z", method: "GET", path: "/r", status: 404, code: "not_found", durationMs: 0 }),
      L({ at: "2026-10-07T13:39:01.000Z", method: "POST", path: "/r", status: 404, code: "not_found", durationMs: 0 }),
      L({ at: "2026-10-07T13:39:02.000Z", method: "GET", path: "/r/complete", status: 405, code: "method_not_allowed", durationMs: 0 }),
      L({ at: "2026-10-07T13:39:03.000Z", method: "GET", path: "/r/v1/models", status: 404, code: "not_found", durationMs: 0 }),
      L({ at: "2026-10-07T13:40:00.000Z", method: "POST", path: "/r/complete", status: 200, code: "ok", durationMs: 100, inputTokens: 1, outputTokens: 1 }),
      L({ at: "2026-10-07T13:41:00.000Z", method: "GET", path: "/r/health", status: 401, code: "unauthorized", durationMs: 1 }),
    ];
    const u = aggregateRelay(lines, { days: 7, now: NOW, tz: TZ });
    expect(u.totals).toMatchObject({ calls: 1, ok: 1, failed: 0, okRate: 1, healthChecks: 1, otherRequests: 4 });
    expect(u.failureCodes).toEqual([]);
    expect(u.recentFailures).toEqual([]);
  });
});

describe("aggregateRelay", () => {
  const u = aggregateRelay(FIXTURE, { days: 7, now: NOW, tz: TZ });

  it("health 줄은 사용량에서 빼고 따로 센다, 기간 밖은 무시", () => {
    expect(u.totals.calls).toBe(4);
    expect(u.totals.healthChecks).toBe(2);
    expect(u.totals.otherRequests).toBe(0);
    expect(u.totals.ok).toBe(2);
    expect(u.totals.failed).toBe(2);
    expect(u.totals.okRate).toBe(0.5);
    expect(u.totals.inputTokens).toBe(300);
    expect(u.totals.outputTokens).toBe(30);
  });
  it("일별 버킷은 tz 기준·오래된 순·빈 날 포함", () => {
    expect(u.byDay).toHaveLength(7);
    expect(u.byDay[6].day).toBe("2026-10-08");
    const d7 = u.byDay.find((d) => d.day === "2026-10-07")!;
    expect(d7).toMatchObject({ calls: 2, ok: 2, avgMs: 2000, p95Ms: 3000 });
    expect(u.byDay[0]).toMatchObject({ calls: 0, avgMs: null, p95Ms: null });
  });
  it("실패 코드별 건수·최근 실패(최신순, 메타만)", () => {
    expect(u.failureCodes).toEqual([
      { code: "failed", count: 1 },
      { code: "model_not_allowed", count: 1 },
    ]);
    expect(u.recentFailures[0]).toEqual({ at: "2026-10-08T04:00:00.000Z", method: "POST", path: "/r/complete", status: 400, code: "model_not_allowed", durationMs: 1 });
  });
  it("마지막 listening 이벤트·깨진 줄 수", () => {
    expect(u.lastListening?.models).toEqual(["gpt:a", "sonnet"]);
    expect(u.badLines).toBe(2);
  });
  it("최근 실패는 10건까지", () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      L({ at: `2026-10-08T0${Math.floor(i / 10)}:${String(i % 10).padStart(2, "0")}:00.000Z`, method: "POST", path: "/r/complete", status: 504, code: "timeout", durationMs: 1 }),
    );
    const r = aggregateRelay(many, { days: 1, now: NOW, tz: TZ });
    expect(r.recentFailures).toHaveLength(10);
    expect(r.failureCodes).toEqual([{ code: "timeout", count: 15 }]);
  });
});

describe("helpers", () => {
  it("p95", () => {
    expect(p95([])).toBeNull();
    expect(p95([5])).toBe(5);
    expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
  });
  it("clampDays — 기본 7, 1~30", () => {
    expect(clampDays(null)).toBe(7);
    expect(clampDays("abc")).toBe(7);
    expect(clampDays("0")).toBe(7);
    expect(clampDays("3")).toBe(3);
    expect(clampDays(99)).toBe(30);
  });
  it("recentDayKeys", () => {
    expect(recentDayKeys(3, NOW, TZ)).toEqual(["2026-10-06", "2026-10-07", "2026-10-08"]);
  });
  it("parseLaunchctlList — 실행 중·멈춤·없음", () => {
    const out = "PID\tStatus\tLabel\n18777\t0\tkr.example.relay\n-\t78\tkr.example.watchdog\n";
    expect(parseLaunchctlList(out, "kr.example.relay")).toEqual({ pid: 18777, lastExitStatus: 0 });
    expect(parseLaunchctlList(out, "kr.example.watchdog")).toEqual({ pid: null, lastExitStatus: 78 });
    expect(parseLaunchctlList(out, "kr.example")).toBeNull();
  });
  it("parseWatchdogTail — 마지막 줄 ok/fail", () => {
    expect(parseWatchdogTail("[funnel 2026-10-08T22:01:20] ok\n")).toEqual({ at: "2026-10-08T22:01:20", ok: true, text: "ok" });
    expect(parseWatchdogTail("[funnel a] ok\n[funnel 2026-10-08T22:06:22] fail #1 (x=000)\n")).toEqual({ at: "2026-10-08T22:06:22", ok: false, text: "fail #1 (x=000)" });
    expect(parseWatchdogTail("\n\n")).toBeNull();
  });
  it("interpretHealthStatus — 401·200 은 살아 있음", () => {
    expect(interpretHealthStatus(401)).toBe("alive");
    expect(interpretHealthStatus(200)).toBe("alive");
    expect(interpretHealthStatus(502)).toBe("unexpected");
  });
  it("relayConfig — ~ 확장·빈 값은 설정 안 됨", () => {
    const c = relayConfig({ AI_RELAY_LOG_PATH: "~/Logs/r.log", AI_RELAY_HEALTH_URL: "  ", AI_RELAY_DEPLOY_DIR: "/opt/r" }, "/home/u");
    expect(c.logPath).toBe("/home/u/Logs/r.log");
    expect(c.healthUrl).toBeNull();
    expect(c.deployDir).toBe("/opt/r");
    expect(c.label).toBe("AI 중계 서버");
    expect(isRelayConfigured(c)).toBe(true);
    expect(isRelayConfigured(relayConfig({}, "/home/u"))).toBe(false);
    expect(expandHome("~", "/h")).toBe("/h");
    expect(expandHome("/a/~b", "/h")).toBe("/a/~b");
  });
});

describe("readTail", () => {
  it("끝에서 maxBytes 만 읽고 잘린 첫 줄은 버린다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-tail-"));
    const p = join(dir, "r.log");
    writeFileSync(p, "aaaaaaaaaa\nbbbb\ncccc\n");
    const full = await readTail(p, 1000);
    expect(full).toEqual({ text: "aaaaaaaaaa\nbbbb\ncccc\n", size: 21, truncated: false });
    const tail = await readTail(p, 8); // "bb\ncccc\n" → 첫 부분 줄 버림
    expect(tail.text).toBe("cccc\n");
    expect(tail.truncated).toBe(true);
  });
});
