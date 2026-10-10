import { z } from "zod";

/**
 * 진입점별 env 검증(순수 — process.env 는 호출부가 인자로 넘긴다).
 * ENV_VAULT_KEY 는 lib/envVault 소유라 여기서 검사하지 않는다.
 * AUTH_OPEN_API 경고는 lib/openApi.openApiStartupWarning 이 이미 내므로 중복하지 않는다.
 */
export type EnvEntry = "web" | "worker";
export type EnvReport = { errors: string[]; warnings: string[] };

const present = (v: string | undefined): v is string => v !== undefined && v !== "";

type Rule = { name: string; severity: "error" | "warning"; entries?: EnvEntry[]; schema: z.ZodType; message: string; required?: boolean; lower?: boolean };

const onOff = z.enum(["on", "off"]);

/**
 * 런타임 리더와 같은 정규화 — 값은 trim, 열거형은 소문자까지(resolveProvider·llmCache 가 그렇게 읽는다).
 * 검증이 런타임보다 엄격하면 앱이 받아들이는 값(" API", "0 ")으로 production 기동이 실패한다.
 */
const norm = (v: string | undefined, lower = false): string | undefined => {
  if (v === undefined) return undefined;
  const t = v.trim();
  return lower ? t.toLowerCase() : t;
};
const int = (min: number) => z.string().regex(/^\d+$/).refine((s) => Number(s) >= min);

const RULES: Rule[] = [
  { name: "DATABASE_URL", severity: "error", required: true, schema: z.string().regex(/^postgres(ql)?:\/\//), message: "postgres:// 또는 postgresql:// 로 시작해야 합니다" },
  { name: "TEAMSPACE_DATA_DIR", severity: "warning", schema: z.string().startsWith("/"), message: "절대경로여야 합니다" },
  { name: "LLM_CALL_LOG", severity: "warning", lower: true, schema: onOff, message: "on 또는 off 여야 합니다" },
  { name: "LLM_CACHE", severity: "warning", lower: true, schema: onOff, message: "on 또는 off 여야 합니다" },
  { name: "RATE_LIMIT", severity: "warning", lower: true, schema: onOff, message: "on 또는 off 여야 합니다" },
  { name: "LOG_FORMAT", severity: "warning", lower: true, schema: z.enum(["json", "pretty"]), message: "json 또는 pretty 여야 합니다" },
  { name: "ASK_LLM_PROVIDER", severity: "error", lower: true, schema: z.enum(["api", "cli", "off"]), message: "api, cli, off 중 하나여야 합니다" },
  { name: "LLM_DAILY_BUDGET_TOKENS", severity: "error", schema: int(0), message: "0 이상의 정수여야 합니다" },
  { name: "ANTHROPIC_API_KEY", severity: "warning", schema: z.string().startsWith("sk-ant-"), message: "sk-ant- 로 시작해야 합니다" },
  { name: "ASK_CLAUDE_TIMEOUT_MS", severity: "warning", schema: int(1000), message: "1000 이상의 정수(ms)여야 합니다" },
  { name: "WORKER_INTERVAL_MS", severity: "warning", schema: int(1000), message: "1000 이상의 정수(ms)여야 합니다" },
  { name: "PUBLIC_BASE_URL", severity: "warning", entries: ["web"], schema: z.string().regex(/^https?:\/\/\S+$/), message: "http(s) URL 이어야 합니다" },
  { name: "AUTH_SLACK_BOT_TOKEN", severity: "warning", entries: ["web"], schema: z.string().startsWith("xoxb-"), message: "xoxb- 로 시작해야 합니다" },
];

export function validateEnv(env: NodeJS.ProcessEnv, opts: { entry: EnvEntry; nodeEnv?: string }): EnvReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const push = (sev: "error" | "warning", msg: string) => (sev === "error" ? errors : warnings).push(msg);

  for (const r of RULES) {
    if (r.entries && !r.entries.includes(opts.entry)) continue;
    const v = norm(env[r.name], r.lower);
    if (!present(v)) {
      if (r.required) push(r.severity, `${r.name} 가 필요합니다 (${r.message})`);
      continue;
    }
    if (!r.schema.safeParse(v).success) push(r.severity, `${r.name}: ${r.message}`);
  }

  if (opts.entry === "web") {
    const s = env.AUTH_SECRET;
    if (!present(s) || s.length < 16) {
      const prod = opts.nodeEnv === "production";
      push(prod ? "error" : "warning", `AUTH_SECRET 는 16자 이상이어야 합니다${prod ? "" : " (production 에서는 기동 실패)"}`);
    }
  }

  const budget = norm(env.LLM_DAILY_BUDGET_TOKENS);
  if (present(budget) && /^\d+$/.test(budget) && Number(budget) > 0 && norm(env.LLM_CALL_LOG, true) === "off") {
    warnings.push("LLM_DAILY_BUDGET_TOKENS 는 LLM_CALL_LOG=off 면 적용되지 않습니다");
  }

  return { errors, warnings };
}

export function formatEnvReport(r: EnvReport): string {
  const lines: string[] = [];
  if (r.errors.length) lines.push("[env] 오류:", ...r.errors.map((e) => `  - ${e}`));
  if (r.warnings.length) lines.push("[env] 경고:", ...r.warnings.map((w) => `  - ${w}`));
  return lines.join("\n");
}
