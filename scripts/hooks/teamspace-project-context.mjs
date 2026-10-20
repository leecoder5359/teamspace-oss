#!/usr/bin/env node
/**
 * PostToolUse 훅: 세션을 연 레포 밖의 매핑된 프로젝트 경로를 건드리면
 * 그 프로젝트의 TeamSpace 컨텍스트(레슨·보드·결정)를 세션에 한 번 주입한다.
 *
 * SessionStart 훅(teamspace-context.mjs)은 세션 cwd 하나만 본다 — teamspace 에서 띄운
 * 세션이 ~/dev/ljun/banjang 을 다루면 반장 레슨이 한 줄도 안 들어왔다. 여기서는
 * 도구 입력의 경로 필드(file_path·notebook_path·path)와 Bash command 의 작업 디렉터리 대상을 라우트룰로 해석해,
 * 시작 프로젝트와 다른 프로젝트면 GET /api/context?cwd=<그 레포> 를 additionalContext 로 넣는다.
 *
 * - Bash command 는 작업 디렉터리를 바꾸는 대상만 본다 — `cd <p>`·`git -C <p>`·`--cwd <p>|--cwd=<p>`,
 *   그것도 실제 존재하는 디렉터리일 때만(결정: cd·git -C·--cwd 대상만, cmvfbme8s007i3r1ymfrh26jx).
 *   그 밖의 인자·URL 에 스친 경로 문자열은 계속 무시한다: 그것만으로 ≈10KB 가 주입되던 문제(리뷰 A-2).
 * - 프로젝트별로 세션(서브에이전트는 에이전트별)당 한 번. 상태는 tmpdir 의 작은 json.
 * - 모든 후보 경로가 세션 cwd 안이면 네트워크 없이 바로 끝난다(대부분의 호출).
 * - 매핑된 경로(라우트룰 적중·시작 프로젝트 아님·아직 주입 안 함)를 건드렸는데 컨텍스트 요청이 실패하면
 *   (서버 다운·시간 초과·non-ok·빈 응답) <teamspace-context-error> 한 줄을 세션당 한 번만 보이고(상태 errorShown),
 *   그 뒤로는 조용히 fail-open.
 * - 매핑을 알기 전의 실패는 조용히 끝난다: 토큰 없음은 주입 실패가 아니라 설정 상태라서(형제 훅
 *   teamspace-context·prompt-lessons 와 같은 규칙 — 토큰 없는 클론·OSS 에서 아무 경로나 읽을 때마다 에러가
 *   뜨면 안 된다), 규칙을 못 받았고 캐시도 없으면 그 경로가 매핑인지 모르므로.
 * - 주입 내용: 세션 시작 주입(SessionStart·SubagentStart)을 받은 쪽 — 메인 세션(agent_id 없음)과 역할 에이전트
 *   (agent_type 이 implementer|reviewer|researcher 또는 <이름>-<역할>) — 엔 그 프로젝트 델타(sections=project ~3KB:
 *   프로젝트·스택 레슨·계정·태스크·개수)만 넣는다. 전역·필수 규칙은 이미 세션에 있어서다(감사 doc cmvfg2ytk).
 *   그 밖의 서브에이전트(Explore 등, agent_type 모름 포함)는 시작 주입이 없으므로 종전 compact 전체.
 *   서버가 아직 sections=project 를 모르면(HTTP 400) compact 로 한 번 다시 부른다.
 * - 덤으로 라이브 세션 보드 하트비트(POST /api/sessions/heartbeat)를 세션당 10분에 1번 보낸다(1초 제한, 실패 무해).
 * 설정은 teamspace-context.mjs 와 같다: ~/.claude/teamspace.json 또는 env WS_BASE / WS_TOKEN.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_NAME = "teamspace-project-context.mjs";
const RULES_TTL_MS = 10 * 60 * 1000;
export const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;

/**
 * 라이브 세션 보드 하트비트 차례인가(세션당 10분에 1번). 차례면 시각을 먼저 적어 두고 true —
 * 같은 세션의 병렬 도구 호출이 겹쳐도 대개 한 번만 나간다. 상태 파일을 못 읽으면 첫 호출로 본다.
 */
export function claimHeartbeat(stateFile, now = Date.now()) {
  let last = 0;
  try {
    last = Number(JSON.parse(readFileSync(stateFile, "utf8")).at) || 0;
  } catch {
    /* 첫 호출 */
  }
  if (now - last < HEARTBEAT_INTERVAL_MS) return false;
  try {
    writeFileSync(stateFile, JSON.stringify({ at: now }));
  } catch {
    return false; // 기록 못 하면 매 호출마다 쏘게 되므로 보내지 않는다
  }
  return true;
}

export function heartbeatStateFile(sessionId, dir = tmpdir()) {
  return join(dir, `teamspace-heartbeat-${String(sessionId).replace(/[^\w.-]/g, "_")}.json`);
}

/** 하트비트 발송(1초 제한, 실패 무해). */
async function sendHeartbeat(base, token, sessionId, cwd) {
  try {
    await fetch(`${base}/api/sessions/heartbeat`, {
      method: "POST",
      headers: { "x-ws-token": token, "content-type": "application/json" },
      body: JSON.stringify({ sessionId, cwd }),
      signal: AbortSignal.timeout(1000),
    });
  } catch {
    /* 무해 */
  }
}

/** 프로젝트 컨텍스트 요청 URL. via=PostToolUse 는 서버의 레슨 주입 기록에 이 훅이 불렀음을 남긴다.
    delta = 프로젝트 델타(sections=project), 아니면 compact 전체. */
export function projectContextUrl(base, cwdPrefix, { delta = false } = {}) {
  const mode = delta ? "sections=project" : "compact=1";
  return `${base}/api/context?format=md&${mode}&via=PostToolUse&cwd=${encodeURIComponent(cwdPrefix)}`;
}

// teamspace-subagent-start.mjs ROLE_AGENTS·roleOf 의 사본(훅은 파일 하나씩 전역으로 복사된다) — 같은지는 테스트가 확인한다.
export const ROLE_AGENTS = ["implementer", "reviewer", "researcher"];

/** agent_type → 역할. 역할 이름 그대로이거나 "<이름>-<역할>" 이면 그 역할, 아니면 null. */
export function roleOf(agentType) {
  if (typeof agentType !== "string") return null;
  return ROLE_AGENTS.find((r) => agentType === r || agentType.endsWith(`-${r}`)) ?? null;
}

/** 델타를 받을 쪽인가 — 세션 시작 주입을 받은 메인 세션(agent_id 없음)과 역할 에이전트만. agent_type 을 모르면 compact. */
export function wantsDelta(input) {
  return !input?.agent_id || !!roleOf(input.agent_type);
}

/**
 * Bash command 에서 작업 디렉터리를 바꾸는 대상 토큰만 뽑는다: `cd <p>`·`git -C <p>`·`--cwd <p>`·`--cwd=<p>`.
 * 따옴표는 벗기고, `cd -`·`cd` 단독 같은 옵션/빈 대상은 버린다. 그 밖의 경로 문자열은 보지 않는다(리뷰 A-2).
 */
export function cwdTargetsFromCommand(command) {
  if (typeof command !== "string") return [];
  const re = /(?:^|[\s;&|(`{])(?:cd\s+|git\s+-C\s+|--cwd(?:\s+|=))("(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|)`}]+)/g;
  const out = [];
  for (const m of command.matchAll(re)) {
    const t = m[1];
    const q = t[0] === '"' || t[0] === "'" ? t.slice(1, -1) : t;
    if (q && !q.startsWith("-")) out.push(q);
  }
  return out;
}

function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 도구 입력에서 파일시스템 경로 후보를 뽑는다(절대경로로 정규화).
 * 경로 필드는 그대로, Bash command 는 cd·git -C·--cwd 대상 중 실제 디렉터리(isDir)만.
 */
export function extractPaths(toolInput, cwd, home = homedir(), isDir = isDirectory) {
  const out = new Set();
  const add = (p, keep = () => true) => {
    if (typeof p !== "string" || !p) return;
    let q = p;
    if (q === "~" || q.startsWith("~/")) q = join(home, q.slice(1));
    const abs = isAbsolute(q) ? resolve(q) : resolve(cwd, q);
    if (keep(abs)) out.add(abs);
  };
  if (!toolInput || typeof toolInput !== "object") return [];
  add(toolInput.file_path);
  add(toolInput.notebook_path);
  add(toolInput.path);
  for (const t of cwdTargetsFromCommand(toolInput.command)) add(t, isDir);
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

  // 라이브 세션 보드 하트비트 — 세션당 10분에 1번, 경로와 무관하게(대부분의 호출은 아래에서 바로 끝난다).
  // 전역 사본과 프로젝트 훅이 같은 상태 파일을 보므로 둘 다 돌아도 한 번만 나간다.
  let beat = Promise.resolve();
  if (claimHeartbeat(heartbeatStateFile(input.session_id))) {
    const c = config();
    if (c.token) beat = sendHeartbeat(c.base, c.token, input.session_id, cwd);
  }
  try {
    await work(input, cwd);
  } finally {
    await beat;
  }
}

/** 주입 실패 한 줄(세션당 한 번). 레슨을 직접 보는 길을 같이 적는다. */
export function errorContext(cwdPrefix, reason) {
  return (
    `<teamspace-context-error cwd="${cwdPrefix}">TeamSpace 프로젝트 컨텍스트 주입 실패: ${reason}` +
    ` — 레슨은 pnpm ws lesson ls --project 로 직접 본다</teamspace-context-error>`
  );
}

function errorReason(e) {
  const name = e?.name && e.name !== "Error" ? `${e.name}: ` : "";
  return `${name}${e?.message ?? String(e)}`;
}

/**
 * 본 작업. deps 는 테스트용 주입점(fetchFn·stateDir·conf·write·isDir); 실제 실행은 기본값.
 * 실패는 fail-open 이되, 매핑된 경로를 건드린 세션엔 에러 한 줄을 한 번 보인다.
 */
export async function work(input, cwd, deps = {}) {
  const { fetchFn = fetch, stateDir = tmpdir(), conf = config(), write = (s) => process.stdout.write(s), isDir } = deps;
  const paths = extractPaths(input.tool_input, cwd, undefined, isDir);
  const outside = paths.filter((p) => p !== cwd && !p.startsWith(cwd + sep));
  if (outside.length === 0) return; // 전부 세션 cwd 안
  if (shouldYieldToProjectHook(cwd)) return;

  const key = `${input.session_id}-${input.agent_id ?? "main"}`.replace(/[^\w.-]/g, "_");
  const stateFile = join(stateDir, `teamspace-project-context-${key}.json`);
  let state = {};
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    /* 첫 호출 */
  }
  const emit = (additionalContext) =>
    write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } }));

  const { base, token } = conf;
  if (!token) return; // 설정 상태 — 조용히(헤더 참고)
  const headers = { "x-ws-token": token };
  let pick = null; // 매핑된 경로를 건드렸을 때만 채워진다 — 에러 줄은 이게 있을 때만
  try {
    if (!state.rules || Date.now() - (state.rulesAt ?? 0) > RULES_TTL_MS) {
      try {
        const res = await fetchFn(`${base}/api/route-rules`, { headers, signal: AbortSignal.timeout(2000) });
        if (!res.ok) throw new Error(`route-rules HTTP ${res.status}`);
        state.rules = (await res.json()).rules ?? [];
        state.rulesAt = Date.now();
      } catch (e) {
        if (!state.rules) throw e;
        /* 묵은 규칙으로 계속 */
      }
    }
    if (!("baseProjectId" in state)) state.baseProjectId = resolveRule(cwd, state.rules)?.projectId ?? null;
    state.injected ??= [];

    pick = pickProject(paths, state.rules, state);
    if (!pick) return;
    let delta = wantsDelta(input);
    let res = await fetchFn(projectContextUrl(base, pick.cwdPrefix, { delta }), { headers, signal: AbortSignal.timeout(3000) });
    if (delta && res.status === 400) {
      // 서버가 아직 sections=project 를 모른다(배포 전) — compact 로 한 번만 다시.
      delta = false;
      res = await fetchFn(projectContextUrl(base, pick.cwdPrefix), { headers, signal: AbortSignal.timeout(3000) });
    }
    if (!res.ok) throw new Error(`context HTTP ${res.status}`);
    const md = await res.text();
    if (!md.trim()) throw new Error("빈 응답");

    state.injected.push(pick.projectId);
    const repoDocs = ["AGENTS.md", "CLAUDE.md"].filter((f) => existsSync(join(pick.cwdPrefix, f)));
    const note =
      (delta
        ? `이 세션은 ${cwd} 에서 시작했지만 ${pick.cwdPrefix} 를 다루고 있어 그 프로젝트의 델타(프로젝트·스택 레슨·태스크)만 주입한다. ` +
          `전역 규칙은 이미 이 세션에 있다 — 이 레포 작업에는 그것과 아래 레슨이 함께 적용된다.`
        : `이 세션은 ${cwd} 에서 시작했지만 ${pick.cwdPrefix} 를 다루고 있어 그 프로젝트의 팀 컨텍스트를 주입한다. ` +
          `이 레포 작업에는 아래 레슨이 적용된다.`) +
      (repoDocs.length ? ` 그 레포의 ${repoDocs.map((f) => join(pick.cwdPrefix, f)).join(" · ")} 도 작업 전에 읽는다.` : "");
    emit(`<teamspace-context source="${base}" cwd="${pick.cwdPrefix}">\n${note}\n\n${md}\n</teamspace-context>`);
  } catch (e) {
    // 매핑을 알기 전 실패(규칙 못 받음·캐시 없음)는 조용히, 매핑된 경로의 주입 실패만 세션당 한 번 보인다.
    if (pick && !state.errorShown) {
      state.errorShown = true;
      emit(errorContext(pick.cwdPrefix, errorReason(e)));
    }
  } finally {
    try {
      writeFileSync(stateFile, JSON.stringify(state));
    } catch {
      /* 무해 */
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
