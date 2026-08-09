#!/usr/bin/env node
/**
 * SessionEnd 훅 (W3 mem-2 1단계): 세션 종료를 TeamSpace /api/ingest 에 기록한다.
 * 인증은 에이전트 토큰(~/.claude/teamspace.json). 실패해도 세션 종료를 막지 않는다.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_NAME = "teamspace-session-end.mjs";

/**
 * 전역 사본(~/.claude/hooks)으로 실행됐고 cwd 프로젝트의 settings 에 같은
 * 스크립트가 등록돼 있으면 양보한다 — 프로젝트 훅이 정본, 전역은 등록 없는
 * 레포 전용 안전망. 파싱이 깨진 settings 는 Claude Code 가 통째로 무시해
 * 프로젝트 훅도 돌지 않으므로 양보하지 않는다(중복 기록이 누락보다 낫다).
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
    return;
  }
  if (!input.session_id) return;
  if (shouldYieldToProjectHook(input.cwd || process.cwd())) return;

  // D8(W8): 팀 프로젝트 cwd(라우트룰 매칭)일 때만 agentmemory 요약 "메타"를 함께 적재.
  // 관찰 원문은 개인정보·시크릿 위험(감사 mem-6/12)으로 팀 서버에 보내지 않는다.
  let summaryMeta = null;
  try {
    const rulesRes = await fetch(`${base}/api/route-rules`, {
      headers: { "x-ws-token": token },
      signal: AbortSignal.timeout(2000),
    });
    if (rulesRes.ok) {
      const { rules } = await rulesRes.json();
      const matched = (rules ?? []).some((r) => input.cwd && input.cwd.startsWith(r.cwdPrefix));
      if (matched) {
        const amEnv = readFileSync(join(homedir(), ".agentmemory", ".env"), "utf8");
        const secret = (/AGENTMEMORY_SECRET=("?)([^"\n]+)\1/.exec(amEnv) ?? [])[2];
        if (secret) {
          const amRes = await fetch(
            `http://127.0.0.1:3111/agentmemory/sessions?limit=50`,
            { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(2000) },
          );
          if (amRes.ok) {
            const { sessions } = await amRes.json();
            const mine = (sessions ?? []).find((s) => s.id === input.session_id);
            if (mine) {
              summaryMeta = {
                firstPrompt: (mine.firstPrompt ?? "").slice(0, 200),
                observationCount: mine.observationCount ?? null,
                startedAt: mine.startedAt ?? null,
              };
            }
          }
        }
      }
    }
  } catch {
    /* agentmemory 미가동 등 — 요약 없이 진행 */
  }

  try {
    await fetch(`${base}/api/ingest`, {
      method: "POST",
      headers: { "x-ws-token": token, "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: input.session_id,
        cwd: input.cwd,
        status: "ended",
        items: [
          {
            kind: "summary",
            externalRef: `end:${input.session_id}`,
            body: { reason: input.reason ?? "ended", endedAt: new Date().toISOString(), ...(summaryMeta ?? {}) },
          },
        ],
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    /* 무해 */
  }
}

main();
