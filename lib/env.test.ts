import { describe, expect, it } from "vitest";
import { formatEnvReport, validateEnv } from "./env";

const GOOD = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  AUTH_SECRET: "a-very-long-secret-value-1234",
} as unknown as NodeJS.ProcessEnv;
const env = (o: Record<string, string>): NodeJS.ProcessEnv => ({ ...GOOD, ...o }) as NodeJS.ProcessEnv;

describe("validateEnv", () => {
  it("정상 env 는 errors·warnings 둘 다 비어 있다", () => {
    expect(validateEnv(GOOD, { entry: "web", nodeEnv: "production" })).toEqual({ errors: [], warnings: [] });
    expect(validateEnv(GOOD, { entry: "worker", nodeEnv: "production" })).toEqual({ errors: [], warnings: [] });
  });

  it("DATABASE_URL 누락·잘못된 접두는 error", () => {
    const r = validateEnv({} as NodeJS.ProcessEnv, { entry: "worker" });
    expect(r.errors.join("\n")).toContain("DATABASE_URL");
    const r2 = validateEnv(env({ DATABASE_URL: "mysql://x" }), { entry: "worker" });
    expect(r2.errors.join("\n")).toContain("DATABASE_URL");
    expect(validateEnv(env({ DATABASE_URL: "postgres://x" }), { entry: "worker" }).errors).toEqual([]);
  });

  it("AUTH_SECRET: production 은 error, 그 외 warning, worker 는 검사 안 함", () => {
    const e = { DATABASE_URL: GOOD.DATABASE_URL } as unknown as NodeJS.ProcessEnv;
    expect(validateEnv(e, { entry: "web", nodeEnv: "production" }).errors.join()).toContain("AUTH_SECRET");
    const dev = validateEnv(e, { entry: "web", nodeEnv: "development" });
    expect(dev.errors).toEqual([]);
    expect(dev.warnings.join()).toContain("AUTH_SECRET");
    expect(validateEnv(env({ AUTH_SECRET: "short" }), { entry: "web", nodeEnv: "production" }).errors.join()).toContain("AUTH_SECRET");
    expect(validateEnv(e, { entry: "worker", nodeEnv: "production" })).toEqual({ errors: [], warnings: [] });
  });

  it("접두·형식 위반은 warning", () => {
    const w = (o: Record<string, string>, entry: "web" | "worker" = "web") => validateEnv(env(o), { entry, nodeEnv: "development" });
    expect(w({ ANTHROPIC_API_KEY: "nope" }).warnings.join()).toContain("ANTHROPIC_API_KEY");
    expect(w({ TEAMSPACE_DATA_DIR: "rel/dir" }).warnings.join()).toContain("TEAMSPACE_DATA_DIR");
    expect(w({ LLM_CALL_LOG: "maybe" }).warnings.join()).toContain("LLM_CALL_LOG");
    expect(w({ LLM_CACHE: "x" }).warnings.join()).toContain("LLM_CACHE");
    expect(w({ RATE_LIMIT: "x" }).warnings.join()).toContain("RATE_LIMIT");
    expect(w({ LOG_FORMAT: "xml" }).warnings.join()).toContain("LOG_FORMAT");
    expect(w({ LOG_FORMAT: "pretty" }).warnings.join()).not.toContain("LOG_FORMAT");
    expect(w({ ASK_CLAUDE_TIMEOUT_MS: "10" }).warnings.join()).toContain("ASK_CLAUDE_TIMEOUT_MS");
    expect(w({ WORKER_INTERVAL_MS: "abc" }, "worker").warnings.join()).toContain("WORKER_INTERVAL_MS");
    expect(w({ PUBLIC_BASE_URL: "ftp://x" }).warnings.join()).toContain("PUBLIC_BASE_URL");
    expect(w({ AUTH_SLACK_BOT_TOKEN: "abc" }).warnings.join()).toContain("AUTH_SLACK_BOT_TOKEN");
    expect(w({ ANTHROPIC_API_KEY: "sk-ant-x", LLM_CALL_LOG: "on", PUBLIC_BASE_URL: "https://a.b" }).warnings).toEqual([]);
  });

  it("web 전용 규칙은 worker 에서 검사하지 않는다", () => {
    const r = validateEnv(env({ PUBLIC_BASE_URL: "ftp://x", AUTH_SLACK_BOT_TOKEN: "abc" }), { entry: "worker" });
    expect(r.warnings).toEqual([]);
  });

  it("ASK_LLM_PROVIDER·LLM_DAILY_BUDGET_TOKENS 위반은 error", () => {
    expect(validateEnv(env({ ASK_LLM_PROVIDER: "gpt" }), { entry: "web", nodeEnv: "production" }).errors.join()).toContain("ASK_LLM_PROVIDER");
    for (const v of ["api", "cli", "off"]) expect(validateEnv(env({ ASK_LLM_PROVIDER: v }), { entry: "web" }).errors).toEqual([]);
    for (const v of ["-1", "1.5", "abc"]) {
      expect(validateEnv(env({ LLM_DAILY_BUDGET_TOKENS: v }), { entry: "web" }).errors.join()).toContain("LLM_DAILY_BUDGET_TOKENS");
    }
    expect(validateEnv(env({ LLM_DAILY_BUDGET_TOKENS: "0" }), { entry: "web" }).errors).toEqual([]);
  });

  it("런타임과 같이 trim·(열거형) 소문자로 정규화한 뒤 검사 — 공백·대소문자로 production 기동이 실패하지 않는다", () => {
    const r = validateEnv(
      env({ ASK_LLM_PROVIDER: " API", LLM_DAILY_BUDGET_TOKENS: "0 ", LOG_FORMAT: "JSON\n", LLM_CACHE: " Off ", ASK_CLAUDE_TIMEOUT_MS: " 5000", DATABASE_URL: " postgresql://u:p@h/db " }),
      { entry: "web", nodeEnv: "production" },
    );
    expect(r).toEqual({ errors: [], warnings: [] });
    // 정규화해도 틀린 값은 그대로 잡힌다
    expect(validateEnv(env({ ASK_LLM_PROVIDER: " gpt " }), { entry: "web" }).errors.join()).toContain("ASK_LLM_PROVIDER");
    expect(validateEnv(env({ LLM_DAILY_BUDGET_TOKENS: " 1 2 " }), { entry: "web" }).errors.join()).toContain("LLM_DAILY_BUDGET_TOKENS");
    // 공백뿐인 필수 값은 없는 것과 같다
    expect(validateEnv(env({ DATABASE_URL: "   " }), { entry: "worker" }).errors.join()).toContain("DATABASE_URL 가 필요합니다");
    // 예산 경고도 정규화된 값으로 판단
    expect(validateEnv(env({ LLM_DAILY_BUDGET_TOKENS: " 1000 ", LLM_CALL_LOG: " OFF" }), { entry: "web" }).warnings).toContain("LLM_DAILY_BUDGET_TOKENS 는 LLM_CALL_LOG=off 면 적용되지 않습니다");
  });

  it("예산 > 0 이고 LLM_CALL_LOG=off 면 경고", () => {
    const r = validateEnv(env({ LLM_DAILY_BUDGET_TOKENS: "1000", LLM_CALL_LOG: "off" }), { entry: "web" });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toContain("LLM_DAILY_BUDGET_TOKENS 는 LLM_CALL_LOG=off 면 적용되지 않습니다");
    expect(validateEnv(env({ LLM_DAILY_BUDGET_TOKENS: "0", LLM_CALL_LOG: "off" }), { entry: "web" }).warnings).toEqual([]);
    expect(validateEnv(env({ LLM_DAILY_BUDGET_TOKENS: "1000" }), { entry: "web" }).warnings).toEqual([]);
  });

  it("ENV_VAULT_KEY 는 검사하지 않는다", () => {
    expect(validateEnv(env({ ENV_VAULT_KEY: "garbage" }), { entry: "web", nodeEnv: "production" })).toEqual({ errors: [], warnings: [] });
  });
});

describe("formatEnvReport", () => {
  it("오류·경고를 여러 줄로 보여 준다", () => {
    const s = formatEnvReport({ errors: ["A 오류"], warnings: ["B 경고"] });
    expect(s).toContain("A 오류");
    expect(s).toContain("B 경고");
    expect(s.split("\n").length).toBeGreaterThan(2);
  });
  it("비어 있으면 빈 문자열", () => {
    expect(formatEnvReport({ errors: [], warnings: [] })).toBe("");
  });
});
