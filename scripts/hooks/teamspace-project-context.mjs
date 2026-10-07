#!/usr/bin/env node
/**
 * PostToolUse 훅: 세션을 연 레포 밖의 매핑된 프로젝트 경로를 건드리면
 * 그 프로젝트의 TeamSpace 컨텍스트(레슨·보드·결정)를 세션에 한 번 주입한다.
 *
 * SessionStart 훅(teamspace-context.mjs)은 세션 cwd 하나만 본다 — teamspace 에서 띄운
 * 세션이 ~/dev/ljun/banjang 을 다루면 반장 레슨이 한 줄도 안 들어왔다. 여기서는
 * 도구 입력의 경로(file_path·path·Bash 명령 속 절대경로)를 라우트룰로 해석해,
 * 시작 프로젝트와 다른 프로젝트면 GET /api/context?cwd=<그 레포> 를 additionalContext 로 넣는다.
 *
 * - 프로젝트별로 세션(서브에이전트는 에이전트별)당 한 번. 상태는 tmpdir 의 작은 json.
 * - 모든 후보 경로가 세션 cwd 안이면 네트워크 없이 바로 끝난다(대부분의 호출).
 * - 서버 다운·미설정 시 아무것도 출력하지 않는다.
 * 설정은 teamspace-context.mjs 와 같다: ~/.claude/teamspace.json 또는 env WS_BASE / WS_TOKEN.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_NAME = "teamspace-project-context.mjs";
const RULES_TTL_MS = 10 * 60 * 1000;

/** 도구 입력에서 파일시스템 경로 후보를 뽑는다(절대경로로 정규화). */
export function extractPaths(toolInput, cwd, home = homedir()) {
  const out = new Set();
  const add = (p) => {
    if (typeof p !== "string" || !p) return;
    let q = p;
    if (q === "~" || q.startsWith("~/")) q = join(home, q.slice(1));
    out.add(isAbsolute(q) ? resolve(q) : resolve(cwd, q));
  };
  if (!toolInput || typeof toolInput !== "object") return [];
  add(toolInput.file_path);
  add(toolInput.notebook_path);
  add(toolInput.path);
  if (typeof toolInput.command === "string") {
    // 절대경로·~경로만 — 상대 토큰은 명령 인자와 구별이 안 된다
    for (const m of toolInput.command.matchAll(/(?:^|[\s'"=:(])((?:~|\/)[^\s'"`;|&()<>]*)/g)) {
      if (m[1] === "/" || m[1].startsWith("//")) continue;
      add(m[1]);
    }
  }
  return [...out];
}

/** lib/ingest.resolveRouteByCwd 와 같은 규칙: priority 높은 것, 동률이면 긴 접두사. */
export function resolveRule(path, rules) {
  const matches = rules.filter((r) => r.projectId && path.startsWith(r.cwdPrefix));
  if (matches.length === 0) return null;
  matches.sort((x, y) => y.priority - x.priority || y.cwdPrefix.length - x.cwdPrefix.length);
  return matches[0];
}

/**
 * 주입할 새 프로젝트를 고른다. 시작 프로젝트·이미 주입한 프로젝트는 건너뛴다.
 * @returns {{ projectId: string, cwdPrefix: string } | null}
 */
export function pickProject(paths, rules, { baseProjectId, injected }) {
  for (const p of paths) {
    const r = resolveRule(p, rules);
    if (!r || r.projectId === baseProjectId || injected.includes(r.projectId)) continue;
    return { projectId: r.projectId, cwdPrefix: r.cwdPrefix };
  }
  return null;
}

/* teamspace-context.mjs 와 같은 양보 규칙 — 전역 사본은 프로젝트 등록이 있으면 물러난다. */
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

async function main() {
  let input;
  try {
    let raw = "";
    for await (const c of process.stdin) raw += c;
    input = JSON.parse(raw);
  } catch {
    return;
  }
  if (!input?.session_id) return;
  const cwd = input.cwd || process.cwd();

  const paths = extractPaths(input.tool_input, cwd);
  if (!paths.some((p) => p !== cwd && !p.startsWith(cwd + sep))) return; // 전부 세션 cwd 안
  if (shouldYieldToProjectHook(cwd)) return;

  const { base, token } = config();
  if (!token) return;
  const headers = { "x-ws-token": token };

  const key = `${input.session_id}-${input.agent_id ?? "main"}`.replace(/[^\w.-]/g, "_");
  const stateFile = join(tmpdir(), `teamspace-project-context-${key}.json`);
  let state = {};
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    /* 첫 호출 */
  }

  try {
    if (!state.rules || Date.now() - (state.rulesAt ?? 0) > RULES_TTL_MS) {
      const res = await fetch(`${base}/api/route-rules`, { headers, signal: AbortSignal.timeout(2000) });
      if (!res.ok) return;
      state.rules = (await res.json()).rules ?? [];
      state.rulesAt = Date.now();
    }
    if (!("baseProjectId" in state)) state.baseProjectId = resolveRule(cwd, state.rules)?.projectId ?? null;
    state.injected ??= [];

    const pick = pickProject(paths, state.rules, state);
    if (pick) {
      const res = await fetch(
        `${base}/api/context?format=md&compact=1&cwd=${encodeURIComponent(pick.cwdPrefix)}`,
        { headers, signal: AbortSignal.timeout(3000) },
      );
      const md = res.ok ? await res.text() : "";
      if (md.trim()) {
        state.injected.push(pick.projectId);
        const repoDocs = ["AGENTS.md", "CLAUDE.md"].filter((f) => existsSync(join(pick.cwdPrefix, f)));
        const note =
          `이 세션은 ${cwd} 에서 시작했지만 ${pick.cwdPrefix} 를 다루고 있어 그 프로젝트의 팀 컨텍스트를 주입한다. ` +
          `이 레포 작업에는 아래 레슨이 적용된다.` +
          (repoDocs.length ? ` 그 레포의 ${repoDocs.map((f) => join(pick.cwdPrefix, f)).join(" · ")} 도 작업 전에 읽는다.` : "");
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: "PostToolUse",
              additionalContext: `<teamspace-context source="${base}" cwd="${pick.cwdPrefix}">\n${note}\n\n${md}\n</teamspace-context>`,
            },
          }),
        );
      }
    }
  } catch {
    /* 서버 다운 → 무해 */
  }
  try {
    writeFileSync(stateFile, JSON.stringify(state));
  } catch {
    /* 무해 */
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
