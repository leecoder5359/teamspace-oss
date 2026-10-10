import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { formatLine, log, reqIdFrom, withReq } from "./log";

const NOW = new Date("2026-10-09T03:04:05.678Z");

describe("formatLine json", () => {
  it("한 줄 JSON — t·level·event 가 앞, reqId 다음, 나머지 필드", () => {
    const line = formatLine("warn", "slack.post_failed", { msg: "슬랙 실패", status: 500, reqId: "r1" }, { format: "json", now: NOW });
    expect(line).not.toContain("\n");
    const o = JSON.parse(line);
    expect(o).toEqual({ t: NOW.toISOString(), level: "warn", event: "slack.post_failed", reqId: "r1", msg: "슬랙 실패", status: 500 });
    expect(Object.keys(o).slice(0, 4)).toEqual(["t", "level", "event", "reqId"]);
  });

  it("필드 없이도 된다", () => {
    expect(JSON.parse(formatLine("info", "worker.started", undefined, { format: "json", now: NOW }))).toEqual({
      t: NOW.toISOString(),
      level: "info",
      event: "worker.started",
    });
  });

  it("Error 는 {name,message,stack(앞 5줄)} 로", () => {
    const e = new TypeError("boom");
    e.stack = ["TypeError: boom", "a", "b", "c", "d", "e", "f"].join("\n");
    const o = JSON.parse(formatLine("error", "x.failed", { err: e }, { format: "json", now: NOW }));
    expect(o.err).toEqual({ name: "TypeError", message: "boom", stack: "TypeError: boom\na\nb\nc\nd" });
  });

  it("Error 의 code(문자열·숫자)와 cause(한 단계)를 싣는다", () => {
    const inner = Object.assign(new Error("db down"), { code: 57014, cause: new Error("deeper") });
    const e = Object.assign(new Error("Unique constraint", { cause: inner }), { code: "P2002" });
    const o = JSON.parse(formatLine("error", "x.failed", { err: e }, { format: "json", now: NOW }));
    expect(o.err.code).toBe("P2002");
    expect(o.err.cause).toMatchObject({ name: "Error", message: "db down", code: 57014 });
    expect(o.err.cause.cause).toBeUndefined(); // 깊이 1 까지만
    const odd = Object.assign(new Error("x", { cause: "문자열 원인" }), { code: { nested: true } });
    const o2 = JSON.parse(formatLine("error", "x.failed", { err: odd }, { format: "json", now: NOW }));
    expect(o2.err.code).toBeUndefined(); // 객체 code 는 버린다
    expect(o2.err.cause).toBe("문자열 원인");
  });

  it("중첩된 Error 도 직렬화한다", () => {
    const o = JSON.parse(formatLine("error", "x.failed", { ctx: { cause: new Error("inner") } }, { format: "json", now: NOW }));
    expect(o.ctx.cause.message).toBe("inner");
  });

  it("순환 객체도 throw 하지 않는다", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    let line = "";
    expect(() => {
      line = formatLine("info", "x.cycle", { a }, { format: "json", now: NOW });
    }).not.toThrow();
    const o = JSON.parse(line);
    expect(o.a.name).toBe("a");
    expect(o.a.self).toBe("[Circular]");
  });

  it("직렬화 불가 값(BigInt·throw 하는 toJSON)은 String(v) 로", () => {
    const bad = { toJSON() { throw new Error("nope"); }, toString() { return "BAD"; } };
    const o = JSON.parse(formatLine("info", "x.weird", { n: BigInt(7), bad }, { format: "json", now: NOW }));
    expect(o.n).toBe("7");
    expect(o.bad).toBe("BAD");
  });

  it("t·level·event 는 필드로 덮어쓸 수 없다", () => {
    const o = JSON.parse(formatLine("info", "x.y", { t: "fake", level: "error", event: "z" }, { format: "json", now: NOW }));
    expect(o.t).toBe(NOW.toISOString());
    expect(o.level).toBe("info");
    expect(o.event).toBe("x.y");
  });
});

describe("formatLine pretty", () => {
  it("`HH:MM:SS LEVEL event reqId=… key=value`", () => {
    const line = formatLine("warn", "slack.post_failed", { reqId: "r1", status: 500, msg: "슬랙 실패 함" }, { format: "pretty", now: NOW });
    expect(line).toMatch(/^\d\d:\d\d:\d\d WARN slack\.post_failed reqId=r1 status=500 msg="슬랙 실패 함"$/);
  });

  it("Error 는 name: message 로(필드 줄은 한 줄), 객체는 JSON 으로", () => {
    const e = new Error("a\nb");
    delete (e as { stack?: string }).stack;
    const line = formatLine("error", "x.failed", { err: e, meta: { k: 1 } }, { format: "pretty", now: NOW });
    expect(line).not.toContain("\n");
    expect(line).toContain('err="Error: a\\nb"');
    expect(line).toContain('meta={"k":1}');
  });

  it("Error 필드가 있으면 스택 앞 5줄을 다음 줄들에, code 는 [code] 로", () => {
    const e = Object.assign(new TypeError("boom"), { code: "P2002" });
    e.stack = ["TypeError: boom", "    at a (x.ts:1)", "    at b (x.ts:2)", "    at c", "    at d", "    at e", "    at f"].join("\n");
    const lines = formatLine("error", "x.failed", { err: e }, { format: "pretty", now: NOW }).split("\n");
    expect(lines[0]).toMatch(/ERROR x\.failed err="TypeError: boom \[P2002\]"$/);
    expect(lines.slice(1)).toEqual(["    TypeError: boom", "    at a (x.ts:1)", "    at b (x.ts:2)", "    at c", "    at d"]);
  });

  it("순환 객체도 throw 하지 않는다", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => formatLine("info", "x.cycle", { a }, { format: "pretty", now: NOW })).not.toThrow();
  });
});

describe("log sink", () => {
  const env = { ...process.env };
  let out: MockInstance<typeof console.log>;
  let err: MockInstance<typeof console.error>;
  beforeEach(() => {
    out = vi.spyOn(console, "log").mockImplementation(() => {});
    err = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    process.env = { ...env };
    vi.restoreAllMocks();
  });

  it("warn/error → stderr(console.error), debug/info → stdout(console.log)", () => {
    process.env.LOG_FORMAT = "json";
    process.env.LOG_LEVEL = "debug";
    log.debug("a.debug");
    log.info("a.info");
    log.warn("a.warn");
    log.error("a.error");
    expect(out.mock.calls.map((c) => JSON.parse(String(c[0])).event)).toEqual(["a.debug", "a.info"]);
    expect(err.mock.calls.map((c) => JSON.parse(String(c[0])).event)).toEqual(["a.warn", "a.error"]);
  });

  it("LOG_LEVEL 미지정·알 수 없는 값은 info — debug 만 걸러진다", () => {
    process.env.LOG_FORMAT = "json";
    delete process.env.LOG_LEVEL;
    log.debug("a.debug");
    log.info("a.info");
    process.env.LOG_LEVEL = "verbose";
    log.debug("b.debug");
    log.info("b.info");
    expect(out.mock.calls.map((c) => JSON.parse(String(c[0])).event)).toEqual(["a.info", "b.info"]);
  });

  it("LOG_LEVEL=warn 은 debug·info 를 막고 warn·error 만 낸다(대소문자 무시)", () => {
    process.env.LOG_FORMAT = "json";
    process.env.LOG_LEVEL = " WARN ";
    log.debug("a.debug");
    log.info("a.info");
    log.warn("a.warn");
    log.error("a.error");
    expect(out).not.toHaveBeenCalled();
    expect(err.mock.calls.map((c) => JSON.parse(String(c[0])).event)).toEqual(["a.warn", "a.error"]);
  });

  it("LOG_LEVEL=error 는 withReq 로거에도 적용된다", () => {
    process.env.LOG_FORMAT = "json";
    process.env.LOG_LEVEL = "error";
    const l = withReq({ headers: { get: () => "r1" } });
    l.warn("a.warn");
    l.error("a.error");
    expect(err.mock.calls.map((c) => JSON.parse(String(c[0])).event)).toEqual(["a.error"]);
  });

  it("LOG_FORMAT 미지정이면 production=json, 그 외 pretty", () => {
    delete process.env.LOG_FORMAT;
    vi.stubEnv("NODE_ENV", "production");
    log.info("a.prod");
    vi.stubEnv("NODE_ENV", "development");
    log.info("a.dev");
    vi.unstubAllEnvs();
    expect(JSON.parse(String(out.mock.calls[0][0])).event).toBe("a.prod");
    expect(String(out.mock.calls[1][0])).toMatch(/^\d\d:\d\d:\d\d INFO a\.dev$/);
  });

  it("LOG_FORMAT=pretty 가 production 보다 우선", () => {
    process.env.LOG_FORMAT = "pretty";
    vi.stubEnv("NODE_ENV", "production");
    log.info("a.forced");
    vi.unstubAllEnvs();
    expect(String(out.mock.calls[0][0])).toMatch(/ INFO a\.forced$/);
  });
});

describe("reqIdFrom / withReq", () => {
  afterEach(() => vi.restoreAllMocks());

  it("x-request-id 를 읽는다(없으면 null)", () => {
    expect(reqIdFrom(new Request("http://x/", { headers: { "x-request-id": "abc" } }))).toBe("abc");
    expect(reqIdFrom(new Request("http://x/"))).toBeNull();
    expect(reqIdFrom({ headers: { get: () => "" } })).toBeNull();
  });

  it("withReq 는 모든 줄에 reqId 를 섞는다", () => {
    process.env.LOG_FORMAT = "json";
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const l = withReq(new Request("http://x/", { headers: { "x-request-id": "req-9" } }));
    l.info("a.one", { k: 1 });
    l.error("a.two");
    expect(JSON.parse(String(out.mock.calls[0][0]))).toMatchObject({ event: "a.one", reqId: "req-9", k: 1 });
    expect(JSON.parse(String(err.mock.calls[0][0]))).toMatchObject({ event: "a.two", reqId: "req-9" });
    delete process.env.LOG_FORMAT;
  });

  it("요청 id 가 없으면 reqId 필드를 넣지 않는다", () => {
    process.env.LOG_FORMAT = "json";
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    withReq(new Request("http://x/")).info("a.none");
    expect(JSON.parse(String(out.mock.calls[0][0]))).not.toHaveProperty("reqId");
    delete process.env.LOG_FORMAT;
  });
});
