#!/usr/bin/env node
/**
 * UserPromptSubmit 훅: 사용자가 무슨 일을 하겠다고 말하면 그 메시지에 맞는 팀 레슨을 넣는다.
 *
 * 세션 시작(teamspace-context.mjs)은 '필수' 레슨만 싣고, 나머지(기본·필요할 때만)는 여기서
 * 메시지의 키워드(Lesson.keywords)·언급된 프로젝트(Project.aliases)로 골라 additionalContext 로 넣는다.
 *   POST /api/context/prompt { prompt, cwd, sessionId, exclude } → { markdown, lessonIds, projectIds }
 * - exclude = 이 세션에 이미 넣은 레슨 id(상태 파일 $TMPDIR/teamspace-prompt-lessons-<세션>.json) — 같은 레슨을 반복해 싣지 않는다.
 * - 서버는 프롬프트 원문을 저장·로그하지 않는다(LessonInjection 에 id 만, via=UserPromptSubmit).
 * - 짧은 메시지(공백 제외 6자 미만)는 네트워크 없이 끝낸다.
 * - 3초 제한, 서버 다운·미설정·오류는 아무것도 출력하지 않는다(fail open — 프롬프트를 막지 않는다).
 * 설정은 teamspace-context.mjs 와 같다: ~/.claude/teamspace.json 또는 env WS_BASE / WS_TOKEN.
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_NAME = "teamspace-prompt-lessons.mjs";
export const MIN_PROMPT_CHARS = 6;
export const TIMEOUT_MS = 3000;

/** 세션(서브에이전트는 에이전트별) 상태 파일 경로. */
export function promptStateFile(sessionId, agentId, dir = tmpdir()) {
  const key = `${sessionId}-${agentId ?? "main"}`.replace(/[^\w.-]/g, "_");
  return join(dir, `teamspace-prompt-lessons-${key}.json`);
}

/** 상태 읽기 — 없거나 깨졌으면 빈 상태. */
export function readState(file) {
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    return { injected: Array.isArray(s.injected) ? s.injected.filter((x) => typeof x === "string") : [] };
  } catch {
    return { injected: [] };
  }
}

/** 판정할 만한 메시지인가(공백 제외 길이). */
export function worthAsking(prompt) {
  return typeof prompt === "string" && prompt.replace(/\s+/g, "").length >= MIN_PROMPT_CHARS;
}

/** Claude Code UserPromptSubmit 훅 출력(JSON) — additionalContext 가 사용자 메시지 옆에 붙는다. */
export function hookOutput(markdown, base) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: `<teamspace-lessons source="${base}">\n${markdown}\n</teamspace-lessons>`,
    },
  });
}

/* teamspace-context.mjs 와 같은 양보 규칙 — 전역 사본은 cwd 프로젝트 settings 에 같은 스크립트가 등록돼 있으면 물러난다. */
function shouldYieldToProjectHook(cwd) {
  try {
    const selfPath = fileURLToPath(import.meta.url);
    if (!selfPath.startsWith(join(homedir(), ".claude", "hooks") + sep)) return false;
    for (const rel of [join(".claude", "settings.json"), join(".claude", "settings.local.json")]) {
      let raw;
      try {
        raw = readFileSync(join(cwd, rel), "utf8");
        JSON.parse(raw);
      } catch {
        continue;
      }
      if (raw.includes(SCRIPT_NAME)) return true;
    }
  } catch {
    /* 판정 실패 → 양보하지 않음 */
  }
  return false;
}

function config() {
  let file = {};
  try {
    file = JSON.parse(readFileSync(join(homedir(), ".claude", "teamspace.json"), "utf8"));
  } catch {
    /* 설정 없음 */
  }
  return {
    base: process.env.WS_BASE || file.base || "http://localhost:3002",
    token: process.env.WS_TOKEN || file.token || "",
  };
}

/**
 * 한 번 실행 — 출력할 문자열(없으면 "")을 돌려준다. 테스트가 fetch·상태 디렉터리를 바꿔 끼운다.
 * @param {{ prompt?: string, session_id?: string, cwd?: string, agent_id?: string }} input
 */
export async function run(input, { fetchImpl = fetch, stateDir = tmpdir(), cfg = config() } = {}) {
  if (!input || !worthAsking(input.prompt)) return "";
  const cwd = input.cwd || process.cwd();
  if (!cfg.token) return "";
  const stateFile = input.session_id ? promptStateFile(input.session_id, input.agent_id, stateDir) : null;
  const state = stateFile ? readState(stateFile) : { injected: [] };
  try {
    const res = await fetchImpl(`${cfg.base}/api/context/prompt`, {
      method: "POST",
      headers: { "x-ws-token": cfg.token, "content-type": "application/json" },
      body: JSON.stringify({ prompt: input.prompt, cwd, sessionId: input.session_id ?? null, exclude: state.injected }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return "";
    const j = await res.json();
    const md = typeof j?.markdown === "string" ? j.markdown : "";
    if (!md.trim()) return "";
    if (stateFile) {
      const ids = Array.isArray(j.lessonIds) ? j.lessonIds.filter((x) => typeof x === "string") : [];
      try {
        writeFileSync(stateFile, JSON.stringify({ injected: [...new Set([...state.injected, ...ids])] }));
      } catch {
        /* 무해 — 다음 메시지에서 같은 레슨이 다시 들어갈 수 있을 뿐 */
      }
    }
    return hookOutput(md, cfg.base);
  } catch {
    return ""; // 서버 다운·시간 초과 → 무해
  }
}

async function main() {
  let input;
  try {
    let raw = "";
    for await (const c of process.stdin) raw += c;
    input = JSON.parse(raw);
  } catch {
    return;
  }
  if (!worthAsking(input?.prompt)) return;
  if (shouldYieldToProjectHook(input.cwd || process.cwd())) return;
  const outStr = await run(input);
  if (outStr) process.stdout.write(outStr);
}

/** 직접 실행됐을 때만 main — 테스트가 import 해도 stdin 을 읽지 않게. argv[1] 은 심볼릭 링크일 수 있어 실제 경로로 비교한다. */
function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main().catch(() => {});
