#!/usr/bin/env node
/**
 * git pre-push 훅(Claude 훅 아님): 공유 브랜치 푸시 잠금 **경고**(Console 4, 결정 A — 푸시는 절대 막지 않는다).
 *
 * git 이 stdin 으로 주는 `<local ref> <local sha> <remote ref> <remote sha>` 줄에서 브랜치를 뽑아
 * 잠금 이름 `<repo>/<branch>` 로 바꾸고(repo = 본체 레포 폴더 이름, 워크트리여도 본체 기준, 소문자)
 * GET /api/locks/<name> 을 본다. 남이 잡고 있으면 stderr 로 경고하고 POST /api/locks/<name>/notify
 * (보유자 인박스 알림, 서버가 잠금당 5분 1회로 제한)를 부른 뒤 **항상 exit 0**.
 * 서버가 안 닿으면 1.5초 안에 조용히 통과한다(fail open).
 *
 * 설치: `pnpm ws lock install-hook [--repo <path>]` 가 이 파일을 <git-common-dir>/hooks/teamspace-pre-push.mjs 로
 * 복사하고 pre-push 래퍼를 쓴다(기존 pre-push 는 보존해 뒤에 이어 부른다).
 * 설정은 다른 훅과 같다: ~/.claude/teamspace.json { base, token } 또는 env WS_BASE / WS_TOKEN.
 * 보유자 구분용 세션 id 는 env CLAUDE_SESSION_ID 또는 CLAUDE_CODE_SESSION_ID(Claude 세션 안에서 푸시할 때).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LOCK_NAME_RE = /^[a-z0-9][a-z0-9:/._-]{0,80}$/;
export const TIMEOUT_MS = 1500;

/**
 * pre-push stdin → 브랜치 푸시 목록. 태그·기타 ref 는 뺀다. 같은 브랜치는 한 번만.
 * @param {string} stdin
 * @returns {{ localRef: string, localSha: string, remoteRef: string, remoteSha: string, branch: string, deleting: boolean }[]}
 */
export function parsePushRefs(stdin) {
  const out = [];
  const seen = new Set();
  for (const line of String(stdin ?? "").split("\n")) {
    const [localRef, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
    if (!remoteRef || !remoteRef.startsWith("refs/heads/")) continue;
    const branch = remoteRef.slice("refs/heads/".length);
    if (!branch || seen.has(branch)) continue;
    seen.add(branch);
    out.push({ localRef, localSha, remoteRef, remoteSha, branch, deleting: /^0+$/.test(localSha ?? "") });
  }
  return out;
}

/** git-common-dir(절대경로) → 본체 레포 이름. teamspace-context.mjs 의 repoInfoFromRevParse 와 같은 규칙. */
export function repoNameFromCommonDir(commonDir) {
  const common = String(commonDir ?? "").trim().replace(/\/+$/, "");
  if (!common) return null;
  const mainRoot = basename(common) === ".git" ? dirname(common) : common;
  return basename(mainRoot).replace(/\.git$/, "") || null;
}

/** (repo, branch) → 잠금 이름. 규칙에 안 맞으면(대문자 외 특수문자 등) null — 그 푸시는 검사하지 않는다. */
export function lockNameFor(repo, branch) {
  if (!repo || !branch) return null;
  const name = `${repo}/${branch}`.toLowerCase();
  return LOCK_NAME_RE.test(name) ? name : null;
}

/** 경고 문구(사람·에이전트가 터미널에서 읽는다). */
export function formatWarning(lock) {
  const where = [lock.branch && `브랜치 ${lock.branch}`, lock.cwd].filter(Boolean).join(" · ");
  return [
    `[teamspace] 경고: '${lock.name}' 은 ${lock.holderName} 가 잡고 있습니다 (${lock.ageMin}분 전, ${lock.remainingMin}분 뒤 만료).`,
    lock.note ? `[teamspace]   메모: ${lock.note}` : null,
    where ? `[teamspace]   보유 위치: ${where}` : null,
    `[teamspace]   푸시는 그대로 진행합니다 — 보유자에게 알림을 남겼습니다. 겹치는 CI·배포가 없는지 확인하세요 (pnpm ws lock ls).`,
  ]
    .filter(Boolean)
    .join("\n");
}

function config(env) {
  let file = {};
  try {
    file = JSON.parse(readFileSync(join(homedir(), ".claude", "teamspace.json"), "utf8"));
  } catch {
    /* 설정 없음 */
  }
  return { base: env.WS_BASE || file.base || "http://localhost:3002", token: env.WS_TOKEN || file.token || "" };
}

function defaultCommonDir(cwd) {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * 훅 본체 — 절대 던지지 않는다. 테스트가 fetch·git·설정을 바꿔 끼운다.
 * @param {{ stdin?: string, cwd?: string, env?: Record<string, string | undefined>,
 *   fetchImpl?: (url: string, init?: any) => Promise<any>, commonDir?: (cwd: string) => string | null,
 *   cfg?: { base: string, token: string }, log?: (s: string) => unknown, timeoutMs?: number }} [opts]
 * @returns {Promise<{ checked: string[], warned: string[], notified: string[] }>}
 */
export async function run({
  stdin,
  cwd = process.cwd(),
  env = process.env,
  fetchImpl = fetch,
  commonDir = defaultCommonDir,
  cfg = config(env),
  log = (s) => process.stderr.write(s + "\n"),
  timeoutMs = TIMEOUT_MS,
} = {}) {
  const res = { checked: [], warned: [], notified: [] };
  try {
    if (!cfg.token) return res;
    const repo = repoNameFromCommonDir(commonDir(cwd));
    const names = parsePushRefs(stdin)
      .map((r) => ({ ...r, name: lockNameFor(repo, r.branch) }))
      .filter((r) => r.name);
    if (names.length === 0) return res;
    const session = env.CLAUDE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || "";
    const signal = AbortSignal.timeout(timeoutMs); // 전체 1.5초 — 하나라도 느리면 나머지도 포기(fail open)
    const headers = { "x-ws-token": cfg.token };
    await Promise.all(
      names.map(async (r) => {
        try {
          const q = session ? `?session=${encodeURIComponent(session)}` : "";
          const got = await fetchImpl(`${cfg.base}/api/locks/${encodeURIComponent(r.name)}${q}`, { headers, signal });
          res.checked.push(r.name);
          if (!got.ok) return;
          const { lock } = await got.json();
          if (!lock || !lock.active || lock.mine) return;
          res.warned.push(r.name);
          log(formatWarning(lock));
          const n = await fetchImpl(`${cfg.base}/api/locks/${encodeURIComponent(r.name)}/notify`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ session: session || undefined, branch: r.branch, cwd }),
            signal,
          });
          if (n.ok && (await n.json()).notified) res.notified.push(r.name);
        } catch {
          /* 서버 다운·시간 초과 → 통과 */
        }
      }),
    );
  } catch {
    /* 어떤 경우에도 푸시를 막지 않는다 */
  }
  return res;
}

async function main() {
  let stdin = "";
  try {
    for await (const c of process.stdin) stdin += c;
  } catch {
    /* 무해 */
  }
  await run({ stdin });
  process.exit(0);
}

function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main().catch(() => process.exit(0));
