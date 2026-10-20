#!/usr/bin/env node
/**
 * SubagentStart 훅: 역할 에이전트(implementer·reviewer·researcher)가 뜰 때 팀 레슨을 넣는다.
 * Agent 도구에 name 을 주면 그 이름이 agent_type 으로 온다 — "<이름>-<역할>"(gate-implementer 등)도 역할로 본다(roleOf).
 * settings matcher 도 같은 규칙: `(^|-)(implementer|reviewer|researcher)$`.
 *
 * 서브에이전트에는 SessionStart·UserPromptSubmit 훅이 돌지 않는다 — 시작 시점에 레슨을 넣는 길은 이것뿐이다.
 * 설계 doc cmvfbot82 §3.2. 두 조각을 한 블록으로 묶어 hookSpecificOutput.additionalContext 로 낸다:
 *   ① POST /api/context/prompt { prompt: "role:<역할>", cwd, sessionId, exclude: [] } → 역할 레슨(keywords 에 role:<역할>)
 *   ② GET /api/context?compact=1&sections=lessons&cwd=<cwd> → 세션 레포 레슨(필수 + 프로젝트 범위)
 * - agent_type 에서 역할을 못 찾으면(범용·Explore·implementer-helper 등) 아무것도 하지 않는다 — 기존 동작 보존.
 * - 실패는 한 줄 <teamspace-context-error> 로 알리고 성공한 조각은 그대로 싣는다(fail open — 에이전트를 막지 않는다).
 * - 요청마다 3초 제한, 두 요청은 동시에.
 * 설정은 teamspace-context.mjs 와 같다: ~/.claude/teamspace.json 또는 env WS_BASE / WS_TOKEN.
 */
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_NAME = "teamspace-subagent-start.mjs";
export const TIMEOUT_MS = 3000;
// lib/lessonPromptMatch.ts LESSON_ROLES 의 사본(전역 사본으로도 돌아 lib 를 import 못 함) — 같은지는 테스트가 확인한다.
export const ROLE_AGENTS = ["implementer", "reviewer", "researcher"];

/** agent_type → 역할. 역할 이름 그대로이거나 "<이름>-<역할>" 이면 그 역할, 아니면 null. */
export function roleOf(agentType) {
  if (typeof agentType !== "string") return null;
  return ROLE_AGENTS.find((r) => agentType === r || agentType.endsWith(`-${r}`)) ?? null;
}

/** ① 역할 레슨 요청 본문 — UserPromptSubmit 훅과 같은 API, 프롬프트 대신 role 태그. */
export function rolePromptBody(input, role) {
  return { prompt: `role:${role}`, cwd: input.cwd, sessionId: input.session_id ?? null, exclude: [] };
}

/** ② 세션 레포 레슨 URL. via=SubagentStart 는 레슨 주입 기록에 이 훅을 남긴다. */
export function lessonsUrl(base, cwd) {
  return `${base}/api/context?compact=1&sections=lessons&via=SubagentStart&cwd=${encodeURIComponent(cwd)}`;
}

/** 비지 않은 조각을 한 블록으로. agent=역할, agent_type=원래 값. 다 비면 "". */
export function buildContext({ base, role, agentType, parts }) {
  const live = parts.filter((p) => typeof p === "string" && p.trim());
  if (!live.length) return "";
  return `<teamspace-context source="${base}" agent="${role}" agent_type="${agentType}">\n${live.join("\n\n")}\n</teamspace-context>`;
}

/** 실패 알림 한 줄 — 줄바꿈·꺾쇠는 지워 블록 모양을 지킨다. */
export function errorLine(role, msg) {
  const clean = String(msg).replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
  return `<teamspace-context-error agent="${role}">${clean}</teamspace-context-error>`;
}

/** Claude Code SubagentStart 훅 출력(JSON) — additionalContext 가 서브에이전트 컨텍스트에 붙는다. */
export function hookOutput(additionalContext) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext } });
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

const reason = (e) => (e instanceof Error ? e.message || e.name : String(e));

/**
 * 한 번 실행 — 출력할 문자열(없으면 "")을 돌려준다. 테스트가 fetch·설정을 바꿔 끼운다.
 * @param {{ session_id?: string, cwd?: string, agent_id?: string, agent_type?: string }} input
 */
export async function run(input, { fetchImpl = fetch, cfg = config() } = {}) {
  const role = roleOf(input?.agent_type);
  if (!role) return "";
  const agentType = input.agent_type;
  if (!cfg.token) return hookOutput(errorLine(role, "no token (~/.claude/teamspace.json or WS_TOKEN)"));
  const cwd = input.cwd || process.cwd();
  const headers = { "x-ws-token": cfg.token };

  const roleLessons = fetchImpl(`${cfg.base}/api/context/prompt`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(rolePromptBody({ ...input, cwd }, role)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).then(async (res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    return typeof j?.markdown === "string" ? j.markdown : "";
  });
  const repo = fetchImpl(lessonsUrl(cfg.base, cwd), { headers, signal: AbortSignal.timeout(TIMEOUT_MS) }).then(async (res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  });

  const [r1, r2] = await Promise.allSettled([roleLessons, repo]);
  const errors = [
    r1.status === "rejected" ? `role: ${reason(r1.reason)}` : null,
    r2.status === "rejected" ? `repo: ${reason(r2.reason)}` : null,
  ].filter(Boolean);
  const block = buildContext({
    base: cfg.base,
    role,
    agentType,
    parts: [r1.status === "fulfilled" ? r1.value : "", r2.status === "fulfilled" ? r2.value : ""],
  });
  const out = [block, errors.length ? errorLine(role, errors.join("; ")) : ""].filter(Boolean).join("\n");
  return out ? hookOutput(out) : "";
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
  if (!roleOf(input?.agent_type)) return;
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
