#!/usr/bin/env node
/**
 * SessionStart 훅 (W3 mem-1): TeamSpace 팀 컨텍스트를 세션 시작 시 주입한다.
 *   GET /api/context?format=md&compact=1&cwd=<cwd> → stdout (Claude 컨텍스트로 추가됨)
 *   compact=1: 큰 훅 출력은 Claude Code 가 파일로 빼고 앞 2KB 만 넣는다 — 서버가 ~7KB(CONTEXT_BUDGET) 안으로 줄여 준다.
 *   source(stdin) 가 resume·compact 면 brief=1 을 더해 ~2.5KB 요약만 받는다 — 이어가는 세션은
 *   이미 전체를 한 번 읽었고, 매번 다시 실으면 대화 컨텍스트만 반복해서 먹는다.
 * 새 세션(startup·clear)일 때만 /api/ingest 에 세션 시작(active)을 기록한다(실패 무해).
 * 받은 레슨 섹션의 요약 줄 id(`- **제목** — 요약 \`c…\``)를 UserPromptSubmit 상태 파일(teamspace-prompt-lessons.mjs 와 같은 경로)에 합쳐 둔다 —
 * 세션 시작에 이미 넣은 레슨을 메시지마다 다시 싣지 않게(감사 doc cmvfg2ytk). 제목만 줄은 규칙을 전하지 않으므로 넣지 않는다 —
 * 메시지 기반 주입이 나중에 그 요약을 줄 수 있게. 쓰기 실패는 무해.
 *
 * 설정: ~/.claude/teamspace.json { "base": "http://localhost:3002", "token": "wst_..." }
 *   (env WS_BASE / WS_TOKEN 이 있으면 우선. 토큰은 설정 화면 › 에이전트 토큰에서 발급)
 * 서버 다운·미설정 시 아무것도 출력하지 않고 조용히 종료한다.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_NAME = "teamspace-context.mjs";

/**
 * `git rev-parse --path-format=absolute --abbrev-ref HEAD --show-toplevel --git-common-dir` 출력 → 라이브 세션 보드용 저장소 정보.
 * repo 는 본체 이름(워크트리여도 공통 .git 의 주인), worktree 는 연결된 워크트리일 때만. 분리된 HEAD 는 branch 없음.
 * (git-pre-push.mjs 에 같은 규칙의 사본이 있다 — 훅은 파일 하나씩 전역으로 복사되므로 공유 모듈을 두지 않는다.)
 * @param {string} out
 * @returns {{ branch?: string, repo?: string, worktree?: string }}
 */
export function repoInfoFromRevParse(out) {
  const [branch, toplevel, commonDir] = String(out).split("\n").map((s) => s.trim());
  if (!toplevel || !commonDir) return {};
  const common = commonDir.replace(/\/+$/, "");
  const mainRoot = basename(common) === ".git" ? dirname(common) : common;
  const repo = basename(mainRoot).replace(/\.git$/, "");
  return {
    ...(branch && branch !== "HEAD" ? { branch } : {}),
    ...(repo ? { repo } : {}),
    ...(toplevel !== mainRoot ? { worktree: toplevel } : {}),
  };
}

/** cwd 의 저장소 정보(1초 제한). 저장소가 아니거나 git 이 없거나 느리면 {}. */
export function gitInfo(cwd) {
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--abbrev-ref", "HEAD", "--show-toplevel", "--git-common-dir"], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return repoInfoFromRevParse(out);
  } catch {
    return {};
  }
}

/** 세션 시작 인입 본문 — 저장소 정보는 있을 때만 붙는다. */
export function ingestPayload(sessionId, cwd, git = {}) {
  return { sessionId, cwd, status: "active", ...git };
}

/**
 * 전역 사본(~/.claude/hooks)으로 실행됐고 cwd 프로젝트의 settings 에 같은
 * 스크립트가 등록돼 있으면 양보한다 — 프로젝트 훅이 정본, 전역은 등록 없는
 * 레포 전용 안전망. 파싱이 깨진 settings 는 Claude Code 가 통째로 무시해
 * 프로젝트 훅도 돌지 않으므로 양보하지 않는다(중복 주입이 누락보다 낫다).
 */
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
        continue; /* 없거나 깨짐 → 이 파일로는 양보 근거 없음 */
      }
      if (raw.includes(SCRIPT_NAME)) return true;
    }
  } catch {
    /* 판정 실패 → 양보하지 않음 */
  }
  return false;
}

/**
 * SessionStart source → 주입 모드. 새 세션(startup·clear, source 없는 구버전)은 전체(compact 컨텍스트),
 * 이어가기·자동 압축(resume·compact)은 요약(brief).
 * @param {string | undefined} source
 * @returns {"full" | "brief"}
 */
export function contextModeFor(source) {
  return source === "resume" || source === "compact" ? "brief" : "full";
}

/**
 * 컨텍스트 요청 URL. via=SessionStart 는 서버의 레슨 주입 기록(설정 › 레슨 주입 점검)에 어느 훅이 불렀는지 남긴다.
 * @param {string} base
 * @param {string} cwd
 * @param {"full" | "brief"} mode
 */
export function contextUrl(base, cwd, mode) {
  return `${base}/api/context?format=md&compact=1${mode === "brief" ? "&brief=1" : ""}&via=SessionStart&cwd=${encodeURIComponent(cwd)}`;
}

const LESSON_HEAD = "## 팀 작업규칙·레슨";
const LESSON_ID_RE = /`(c[a-z0-9]{20,})`/g;
/** lib/lessonInject compactLine(`- **제목** — 요약 \`id\``)의 표지 — 제목만 줄(`- **제목** \`id\``)에는 없다. */
const GIST_MARK = "** — ";

/**
 * 컨텍스트 Markdown 의 레슨 섹션(`## 팀 작업규칙·레슨` ~ 다음 `## `)에서 요약 줄(`- **` 로 시작하고 `** — ` 가 있는 줄)의
 * 레슨 id 를 뽑는다(순서대로, 중복 없이). 제목만 줄은 건너뛴다.
 * @param {unknown} markdown
 * @returns {string[]}
 */
export function extractLessonIds(markdown) {
  if (typeof markdown !== "string") return [];
  const out = new Set();
  let inLessons = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) inLessons = line.startsWith(LESSON_HEAD);
    if (!inLessons || !line.startsWith("- **") || !line.includes(GIST_MARK)) continue;
    for (const m of line.matchAll(LESSON_ID_RE)) out.add(m[1]);
  }
  return [...out];
}

/** teamspace-prompt-lessons.mjs promptStateFile 의 사본(훅은 파일 하나씩 전역으로 복사된다) — 같은지는 테스트가 확인한다. */
export function promptStateFile(sessionId, agentId, dir = tmpdir()) {
  const key = `${sessionId}-${agentId ?? "main"}`.replace(/[^\w.-]/g, "_");
  return join(dir, `teamspace-prompt-lessons-${key}.json`);
}

/** 메인 세션의 UserPromptSubmit 상태({ injected })에 ids 를 합친다. 읽기·쓰기 실패는 무해(다음 메시지에 중복이 실릴 수 있을 뿐). */
export function seedPromptState(sessionId, ids, dir = tmpdir()) {
  if (!sessionId || !ids.length) return;
  const file = promptStateFile(sessionId, undefined, dir);
  let injected = [];
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(s.injected)) injected = s.injected.filter((x) => typeof x === "string");
  } catch {
    /* 없음·깨짐 → 새로 */
  }
  try {
    writeFileSync(file, JSON.stringify({ injected: [...new Set([...injected, ...ids])] }));
  } catch {
    /* 무해 */
  }
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
  const { base, token } = config();
  if (!token) return;

  let input = {};
  try {
    let raw = "";
    for await (const c of process.stdin) raw += c;
    input = JSON.parse(raw);
  } catch {
    /* stdin 없음/파싱 실패 → cwd 없이 진행 */
  }
  const cwd = input.cwd || process.cwd();
  if (shouldYieldToProjectHook(cwd)) return;
  const headers = { "x-ws-token": token };
  const mode = contextModeFor(input.source);

  // 세션 시작 기록 (fire-and-forget 성격 — 실패 무시). 이어가기·압축은 같은 세션이라 다시 남기지 않는다.
  if (mode === "full" && input.session_id) {
    try {
      await fetch(`${base}/api/ingest`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(ingestPayload(input.session_id, cwd, gitInfo(cwd))),
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      /* 무해 */
    }
  }

  try {
    const res = await fetch(contextUrl(base, cwd, mode), {
      headers,
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const md = await res.text();
    if (!md.trim()) return;
    if (input.session_id) seedPromptState(input.session_id, extractLessonIds(md));
    process.stdout.write(`<teamspace-context source="${base}" mode="${mode}">\n${md}\n</teamspace-context>\n`);
  } catch {
    /* 서버 다운 → 무해하게 종료 */
  }
}

/** 직접 실행됐을 때만 main — 테스트가 contextModeFor 를 import 해도 stdin 을 읽지 않게.
    argv[1] 은 심볼릭 링크·상대경로일 수 있어 실제 경로로 비교한다. */
function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main();
