/* =====================================================================
   선택적 LLM 합성 레이어 (프로바이더: api | cli | off).
   - api: ANTHROPIC_API_KEY 로 Anthropic Messages API(fetch).
   - cli: 로컬 `claude` CLI 헤드리스(-p) 호출 — 기존 Claude Code 로그인 사용(키 불필요).
   - off: 합성 안 함 → 호출측이 추출형으로 폴백.
   어느 경로든 실패하면 null 을 반환해 추출형으로 안전하게 떨어진다.
   ===================================================================== */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import type { RankedSource } from "@/lib/ask";

const execFileP = promisify(execFile);
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

/**
 * 로컬 `claude` CLI 헤드리스 텍스트 호출(프로바이더 cli 공용).
 * - 중립 cwd(tmpdir)로 띄워 프로젝트 CLAUDE.md/skills/MCP 로딩 오버헤드를 피한다(속도·안전).
 * - 툴 비활성·1턴·텍스트. 바이너리 부재/타임아웃/오류 시 null.
 */
async function runClaudeText(fullPrompt: string): Promise<string | null> {
  if (!fullPrompt.trim()) return null;
  const model = (process.env.ASK_CLAUDE_MODEL || "claude-haiku-4-5").trim();
  const timeout = Math.max(5000, Number(process.env.ASK_CLAUDE_TIMEOUT_MS) || 120_000);
  try {
    const { stdout } = await execFileP(
      "claude",
      ["-p", fullPrompt, "--allowedTools", "", "--max-turns", "1", "--output-format", "text", "--model", model],
      { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, cwd: tmpdir() },
    );
    const text = (stdout || "").trim();
    return text || null;
  } catch {
    return null;
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
): Promise<string | null> {
  if (ranked.length === 0) return null;
  const provider = resolveProvider();
  if (provider === "off") return null;
  if (provider === "api") return callApi(question, ranked);
  return callCli(question, ranked);
}

/**
 * 범용 텍스트 완성(프로바이더 공용). system+user 를 합쳐 한 프롬프트로 처리.
 * 추출·분류 등 Q&A 외 합성에 재사용. 실패/off 면 null.
 */
export async function complete(prompt: string, system?: string): Promise<string | null> {
  const provider = resolveProvider();
  if (provider === "off" || !prompt.trim()) return null;
  if (provider === "api") return apiComplete(prompt, system);
  return cliComplete(prompt, system);
}

async function apiComplete(prompt: string, system?: string): Promise<string | null> {
  const key = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (!key) return null;
  const model = (process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6").trim();
  try {
    const res = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        ...(system ? { system } : {}),
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (data.content ?? []).filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n").trim();
    return text || null;
  } catch {
    return null;
  }
}

async function cliComplete(prompt: string, system?: string): Promise<string | null> {
  return runClaudeText(system ? `${system}\n\n${prompt}` : prompt);
}

/** Anthropic Messages API 경로. */
async function callApi(question: string, ranked: RankedSource[]): Promise<string | null> {
  const key = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (!key) return null;
  const model = (process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6").trim();
  const user = `질문: ${question}\n\n근거:\n${buildContext(ranked)}`;

  try {
    const res = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 700,
        system: SYSTEM,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (data.content ?? [])
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n")
      .trim();
    return text || null;
  } catch {
    return null;
  }
}

/** Q&A 합성 CLI 경로(공용 runClaudeText 사용). */
async function callCli(question: string, ranked: RankedSource[]): Promise<string | null> {
  return runClaudeText(`${SYSTEM}\n\n질문: ${question}\n\n근거:\n${buildContext(ranked)}`);
}
