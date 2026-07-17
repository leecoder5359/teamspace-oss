#!/usr/bin/env node
/**
 * SessionStart 훅 (W3 mem-1): TeamSpace 팀 컨텍스트를 세션 시작 시 주입한다.
 *   GET /api/context?format=md&cwd=<cwd> → stdout (Claude 컨텍스트로 추가됨)
 * 부수적으로 /api/ingest 에 세션 시작(active)을 기록한다(실패 무해).
 *
 * 설정: ~/.claude/teamspace.json { "base": "http://localhost:3002", "token": "wst_..." }
 *   (env WS_BASE / WS_TOKEN 이 있으면 우선. 토큰은 설정 화면 › 에이전트 토큰에서 발급)
 * 서버 다운·미설정 시 아무것도 출력하지 않고 조용히 종료한다.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
    const res = await fetch(`${base}/api/context?format=md&cwd=${encodeURIComponent(cwd)}`, {
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
