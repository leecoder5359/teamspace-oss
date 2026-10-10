/* =====================================================================
   선택적 LLM 합성 레이어 (프로바이더: api | cli | off).
   - api: ANTHROPIC_API_KEY 로 Anthropic Messages API(fetch).
   - cli: 로컬 `claude` CLI 헤드리스(-p) 호출 — 기존 Claude Code 로그인 사용(키 불필요).
   - off: 합성 안 함 → 호출측이 추출형으로 폴백.
   어느 경로든 실패하면 null 을 반환해 추출형으로 안전하게 떨어진다.

   호출마다 LlmCall 1행을 남긴다(lib/aiRoutes/llmCalls — 기능·경로·모델·성패·시간·토큰,
   본문 없음). 기록은 fire-and-forget 이라 호출측 결과·속도에 영향이 없다.

   기능(feature) 태그가 모델 등급·max_tokens 를 정하고(lib/llmPolicy — ask=합성, 나머지=추출),
   같은 프롬프트는 응답 캐시(lib/llmCache)에서 꺼낸다(provider "cache" 로 기록). 모든 호출은
   tracked() 한 곳을 지난다 — 정책·캐시·예산·기록의 단일 관문.
   일일 토큰 예산(LLM_DAILY_BUDGET_TOKENS, lib/llmBudget)을 넘으면 캐시 적중이 아닌 실제 호출을 막는다.
   ===================================================================== */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import type { RankedSource } from "@/lib/ask";
import { recordLlmCall } from "@/lib/aiRoutes/llmCalls";
import { maxTokensFor, modelFor, tierOf } from "@/lib/llmPolicy";
import { cacheEnabled, cacheKey, getCached, putCached } from "@/lib/llmCache";
import { checkBudget } from "@/lib/llmBudget";
import { dayKey } from "@/lib/aiRoutes/relay";
import { log } from "@/lib/log";

const execFileP = promisify(execFile);
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

/**
 * `claude -p` 인자 — 텍스트 합성만 하는 격리된 호출.
 * 워크스페이스 문서·질문이 프롬프트로 들어가므로 인젝션을 전제로 한다:
 * - `--tools ""` 로 도구를 전부 끈다. `--allowedTools` 는 권한 허용목록이라 사용자 설정이
 *   bypassPermissions 면 아무것도 막지 못한다.
 * - `--setting-sources ""` 로 사용자·프로젝트 설정(권한 모드·훅)을 읽지 않고, 권한 모드를 dontAsk 로 고정한다(선택지에 default 는 없다 — 미리 허용 안 된 동작은 전부 거부).
 * - `--strict-mcp-config`(MCP 없음)·`--no-session-persistence`(세션 기록 없음).
 * - `--bare` 는 쓰지 않는다 — OAuth 를 읽지 않아 "키 없는 대체" 가 깨진다.
 * - `--output-format json` — 결과 텍스트와 usage(토큰)를 함께 받는다(parseClaudeCliOutput).
 */
export function claudeCliArgs(fullPrompt: string, model: string): string[] {
  return [
    "-p", fullPrompt,
    "--tools", "",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--permission-mode", "dontAsk",
    "--max-turns", "1",
    "--output-format", "json",
    "--model", model,
  ];
}

/**
 * 호출 라벨. feature 는 화면 '기능별 호출' 표의 행 이름이자 모델 등급·max_tokens 의 기준이다.
 * cache:false 면 응답 캐시를 읽지도 쓰지도 않는다(매번 새 답이 필요한 호출용).
 */
export type LlmCallMeta = { feature?: string; workspaceId?: string | null; cache?: boolean };

/** 한 번의 실제 호출 결과(기록용 메타 포함). text 가 null 이면 실패. */
type Attempt = {
  text: string | null;
  model: string;
  errorKind: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** 상한(max_tokens)에서 잘린 응답 — 호출자엔 돌려주되 캐시에는 넣지 않는다. */
  truncated: boolean;
};

/** tracked 가 run 에 넘기는 정책 결과. */
type Plan = { model: string; maxTokens: number };

/** 예산 초과 로그는 하루 1번만(마지막으로 남긴 날짜 키). */
let lastBudgetWarnDay: string | null = null;
function warnBudgetOnce(used: number, budget: number): void {
  const day = dayKey(new Date());
  if (lastBudgetWarnDay === day) return;
  lastBudgetWarnDay = day;
  log.error("llm.budget_exceeded", {
    msg: `일일 토큰 예산 초과 — 오늘 ${used.toLocaleString("en-US")} / ${budget.toLocaleString("en-US")} 토큰. LLM 호출을 멈춥니다(LLM_DAILY_BUDGET_TOKENS).`,
    used,
    budget,
  });
}

/**
 * 모든 LLM 호출의 단일 관문.
 * (1) feature → 모델·max_tokens(llmPolicy)  (2) 캐시 켜짐이면 조회 — hit 면 provider "cache" 로 기록하고 반환
 * (3) 일일 예산 초과면 호출 없이 budget_exceeded 행만 남기고 null  (4) 아니면 실제 호출 후 LlmCall 기록(기다리지 않음)
 * (5) 성공하고 잘리지 않은 응답만 캐시에 저장(기다리지 않음).
 */
async function tracked(
  provider: "api" | "cli",
  meta: LlmCallMeta | undefined,
  fallbackFeature: string,
  req: { system?: string; prompt: string },
  run: (plan: Plan) => Promise<Attempt>,
): Promise<string | null> {
  const feature = meta?.feature || fallbackFeature;
  const plan: Plan = { model: modelFor(provider, tierOf(feature), process.env), maxTokens: maxTokensFor(feature) };
  const workspaceId = meta?.workspaceId ?? null;
  const key = meta?.cache !== false && cacheEnabled() ? cacheKey({ provider, model: plan.model, system: req.system, prompt: req.prompt, workspaceId }) : null;

  if (key) {
    // 조회 실패(throw/reject)는 miss 로 본다.
    const hit = await getCached(key).catch(() => null);
    if (hit) {
      void recordLlmCall({ workspaceId, feature, provider: "cache", model: hit.model, ok: true, errorKind: null, durationMs: 0, inputTokens: null, outputTokens: null });
      return hit.text;
    }
  }

  const budget = await checkBudget().catch(() => null);
  if (budget && !budget.ok) {
    warnBudgetOnce(budget.used, budget.budget);
    void recordLlmCall({ workspaceId, feature, provider, model: plan.model, ok: false, errorKind: "budget_exceeded", durationMs: 0, inputTokens: null, outputTokens: null });
    return null;
  }

  const t0 = Date.now();
  const a = await run(plan);
  void recordLlmCall({
    workspaceId,
    feature,
    provider,
    model: a.model,
    ok: a.text !== null,
    errorKind: a.text !== null ? null : a.errorKind ?? "unknown",
    durationMs: Date.now() - t0,
    inputTokens: a.inputTokens,
    outputTokens: a.outputTokens,
  });
  // 잘린 응답은 캐시하지 않는다(적중이 lastHitAt 을 갱신해 영영 남는다). 쓰기는 기다리지 않는다.
  if (key && a.text !== null && !a.truncated) void Promise.resolve(putCached({ key, feature, model: a.model, text: a.text, workspaceId })).catch(() => undefined);
  return a.text;
}

/** execFile 오류 → 기록용 분류(메시지·stderr 는 남기지 않는다 — 프롬프트 일부가 섞일 수 있다). */
function cliErrorKind(e: unknown): string {
  const err = e as { code?: unknown; killed?: boolean; signal?: string | null };
  if (err?.code === "ENOENT") return "not_installed";
  if (err?.killed || err?.signal === "SIGTERM") return "timeout";
  if (err?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "too_large";
  if (typeof err?.code === "number") return "exit";
  return "error";
}

type CliParsed = Pick<Attempt, "text" | "errorKind" | "inputTokens" | "outputTokens">;  // truncated 는 CLI 결과에 대응 필드가 없어 항상 false

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

/**
 * `claude -p --output-format json` 의 stdout → 텍스트·토큰.
 * - 결과 객체: `{ type:"result", subtype:"success"|"error_…", is_error, result, usage:{input_tokens,
 *   cache_creation_input_tokens, cache_read_input_tokens, output_tokens}, total_cost_usd, … }`.
 *   입력 토큰은 api 경로와 같게 캐시 생성·읽기를 포함한다. 비용은 LlmCall 에 칸이 없어 버린다.
 * - JSON 이 아니면(구버전 CLI·형식 변경) 종전처럼 평문 텍스트로 보고 토큰은 null.
 * - is_error 거나 subtype 이 success 가 아니면 실패 — errorKind 는 subtype(없으면 "is_error").
 *   메시지 본문은 남기지 않는다(프롬프트 일부가 섞일 수 있다).
 */
export function parseClaudeCliOutput(stdout: string): CliParsed {
  const raw = (stdout || "").trim();
  const none = { inputTokens: null, outputTokens: null };
  if (!raw) return { ...none, text: null, errorKind: "empty" };
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return { ...none, text: raw, errorKind: null };
  }
  // stream-json 이 아닌 json 은 결과 객체 하나. 배열(이벤트 목록)로 오면 마지막 result 를 쓴다.
  if (Array.isArray(o)) o = [...o].reverse().find((e) => (e as { type?: unknown })?.type === "result");
  if (!o || typeof o !== "object" || !("result" in o || "is_error" in o || "usage" in o)) {
    // JSON 이지만 결과 객체가 아니다(예: 응답 자체가 JSON 텍스트) — 평문으로 취급.
    return { ...none, text: raw, errorKind: null };
  }
  const r = o as { subtype?: unknown; is_error?: unknown; result?: unknown; usage?: Record<string, unknown> | null };
  const u = r.usage && typeof r.usage === "object" ? r.usage : null;
  const inTok = u ? [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens].map(num) : null;
  const tokens = {
    inputTokens: inTok && inTok.some((x) => x !== null) ? inTok.reduce<number>((a, b) => a + (b ?? 0), 0) : null,
    outputTokens: u ? num(u.output_tokens) : null,
  };
  const subtype = typeof r.subtype === "string" ? r.subtype : null;
  if (r.is_error === true || (subtype && subtype !== "success")) {
    return { ...tokens, text: null, errorKind: subtype && subtype !== "success" ? subtype : "is_error" };
  }
  const text = typeof r.result === "string" ? r.result.trim() : "";
  return { ...tokens, text: text || null, errorKind: text ? null : "empty" };
}

/**
 * 로컬 `claude` CLI 헤드리스 텍스트 호출(프로바이더 cli 공용).
 * - 중립 cwd(tmpdir)로 띄워 프로젝트 CLAUDE.md/skills 를 읽지 않는다(속도·안전).
 * - 격리 인자는 claudeCliArgs. 바이너리 부재/타임아웃/오류 시 text null.
 * - 출력은 JSON(parseClaudeCliOutput) — 토큰 수를 함께 남긴다.
 * - CLI 에는 출력 상한 플래그가 없어 max_tokens 는 api 경로에만 적용된다.
 */
async function runClaudeText(fullPrompt: string, model: string): Promise<Attempt> {
  if (!fullPrompt.trim()) return { model, text: null, errorKind: "empty_prompt", inputTokens: null, outputTokens: null, truncated: false };
  const timeout = Math.max(5000, Number(process.env.ASK_CLAUDE_TIMEOUT_MS) || 120_000);
  try {
    const { stdout } = await execFileP(
      "claude",
      claudeCliArgs(fullPrompt, model),
      { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, cwd: tmpdir() },
    );
    return { model, ...parseClaudeCliOutput(stdout), truncated: false };
  } catch (e) {
    // 비정상 종료라도 결과 JSON(is_error)이 stdout 에 있으면 그 분류·토큰을 쓴다.
    const out = (e as { stdout?: unknown })?.stdout;
    if (typeof out === "string" && out.trim().startsWith("{")) {
      const p = parseClaudeCliOutput(out);
      if (p.errorKind && p.errorKind !== "empty") return { model, ...p, text: null, truncated: false };
    }
    return { model, text: null, errorKind: cliErrorKind(e), inputTokens: null, outputTokens: null, truncated: false };
  }
}

/** Anthropic Messages API 한 번. 응답 usage 에서 토큰을 읽는다. */
async function runApi(body: { system?: string; user: string; model: string; maxTokens: number }): Promise<Attempt> {
  const model = body.model;
  const fail = (errorKind: string): Attempt => ({ text: null, model, errorKind, inputTokens: null, outputTokens: null, truncated: false });
  const key = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (!key) return fail("no_key");
  try {
    const res = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: body.maxTokens,
        ...(body.system ? { system: body.system } : {}),
        messages: [{ role: "user", content: body.user }],
      }),
    });
    if (!res.ok) return fail(`http_${res.status}`);
    const data = (await res.json()) as {
      content?: { type: string; text?: string }[];
      model?: string;
      stop_reason?: string | null;
      usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    };
    const text = (data.content ?? []).filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n").trim();
    const u = data.usage;
    const input = u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) : null;
    return {
      text: text || null,
      model: typeof data.model === "string" && data.model ? data.model : model,
      errorKind: text ? null : "empty",
      inputTokens: u ? input : null,
      outputTokens: typeof u?.output_tokens === "number" ? u.output_tokens : null,
      truncated: data.stop_reason === "max_tokens",
    };
  } catch {
    return fail("network");
  }
}

export type Provider = "api" | "cli" | "off";

/**
 * 사용할 프로바이더 결정.
 * ASK_LLM_PROVIDER(api|cli|off) 가 명시되면 그대로, 아니면 키 있으면 api·없으면 cli(로컬 claude 시도).
 * cli 는 바이너리가 없으면 실제 호출에서 null 로 떨어진다.
 */
export function resolveProvider(): Provider {
  const explicit = (process.env.ASK_LLM_PROVIDER || "").trim().toLowerCase();
  if (explicit === "api" || explicit === "cli" || explicit === "off") return explicit;
  if ((process.env.ANTHROPIC_API_KEY || "").trim()) return "api";
  return "cli";
}

export function hasLLM(): boolean {
  return resolveProvider() !== "off";
}

/** 현재 프로바이더의 등급별 모델(화면 표시용 — 비밀 아님). off 면 null. */
export function currentModels(): { synthesize: string; extract: string } | null {
  const p = resolveProvider();
  if (p === "off") return null;
  return { synthesize: modelFor(p, "synthesize", process.env), extract: modelFor(p, "extract", process.env) };
}

/** 현재 프로바이더의 합성(ask) 모델 이름(기존 호출부 호환). off 면 null. */
export function currentModel(): string | null {
  return currentModels()?.synthesize ?? null;
}

const SYSTEM =
  "너는 팀 워크스페이스 위키의 Q&A 도우미다. 아래 '근거' 안의 내용만으로 한국어로 간결히 답하라. " +
  "근거에 없으면 모른다고 답하라(추측 금지). 문장 끝에 사용한 근거 번호를 [n] 형식으로 표기하라.";

function buildContext(ranked: RankedSource[]): string {
  return ranked
    .map((r, i) => `[${i + 1}] ${r.title}${r.heading ? ` › ${r.heading}` : ""}\n${r.passage}`)
    .join("\n\n");
}

/**
 * 질문 + 검색된 출처로 답변을 합성. 키 없음/오류/응답 이상이면 null(폴백 신호).
 */
export async function synthesizeAnswer(
  question: string,
  ranked: RankedSource[],
  meta?: LlmCallMeta,
): Promise<string | null> {
  if (ranked.length === 0) return null;
  const provider = resolveProvider();
  if (provider === "off") return null;
  const user = `질문: ${question}\n\n근거:\n${buildContext(ranked)}`;
  const req = { system: SYSTEM, prompt: user };
  if (provider === "api") return tracked("api", meta, "ask", req, (p) => runApi({ system: SYSTEM, user, ...p }));
  return tracked("cli", meta, "ask", req, (p) => runClaudeText(`${SYSTEM}\n\n${user}`, p.model));
}

/**
 * 범용 텍스트 완성(프로바이더 공용). system+user 를 합쳐 한 프롬프트로 처리.
 * 추출·분류 등 Q&A 외 합성에 재사용. 실패/off 면 null.
 * 두 번째 인자는 system 문자열, 또는 { system?, feature?, workspaceId?, cache? }.
 * 모델·max_tokens 는 feature 로 정해진다(llmPolicy). 같은 입력은 캐시에서 돌려준다(cache:false 로 끔).
 */
export async function complete(prompt: string, opts?: string | (LlmCallMeta & { system?: string })): Promise<string | null> {
  const o = typeof opts === "string" ? { system: opts } : opts ?? {};
  const provider = resolveProvider();
  if (provider === "off" || !prompt.trim()) return null;
  const req = { system: o.system, prompt };
  if (provider === "api") return tracked("api", o, "complete", req, (p) => runApi({ system: o.system, user: prompt, ...p }));
  return tracked("cli", o, "complete", req, (p) => runClaudeText(o.system ? `${o.system}\n\n${prompt}` : prompt, p.model));
}
