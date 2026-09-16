#!/usr/bin/env node
/**
 * SessionStart 훅 (W3 mem-1): TeamSpace 팀 컨텍스트를 세션 시작 시 주입한다.
 *   GET /api/context?format=md&compact=1&cwd=<cwd> → stdout (Claude 컨텍스트로 추가됨)
 *   compact=1: 큰 훅 출력은 Claude Code 가 파일로 빼고 앞 2KB 만 넣는다 — 서버가 ~9KB 안으로 줄여 준다.
 * 부수적으로 /api/ingest 에 세션 시작(active)을 기록한다(실패 무해).
 *
 * 설정: ~/.claude/teamspace.json { "base": "http://localhost:3002", "token": "wst_..." }
 *   (env WS_BASE / WS_TOKEN 이 있으면 우선. 토큰은 설정 화면 › 에이전트 토큰에서 발급)
 * 서버 다운·미설정 시 아무것도 출력하지 않고 조용히 종료한다.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_NAME = "teamspace-context.mjs";

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

  // 세션 시작 기록 (fire-and-forget 성격 — 실패 무시)
  if (input.session_id) {
    try {
      await fetch(`${base}/api/ingest`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ sessionId: input.session_id, cwd, status: "active" }),
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      /* 무해 */
    }
  }

  try {
    const res = await fetch(`${base}/api/context?format=md&compact=1&cwd=${encodeURIComponent(cwd)}`, {
      headers,
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const md = await res.text();
    if (!md.trim()) return;
    process.stdout.write(`<teamspace-context source="${base}">\n${md}\n</teamspace-context>\n`);
  } catch {
    /* 서버 다운 → 무해하게 종료 */
  }
}

main();
