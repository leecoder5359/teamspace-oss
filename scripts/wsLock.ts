/**
 * ws lock · ws sessions live — 공유 브랜치 푸시·배포 예약 잠금과 라이브 세션 보드(Console 4).
 * 결정 A: 예약 잠금 + pre-push **경고**(푸시는 막지 않는다). 서버 쪽 규칙은 lib/pushLock.ts.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LOCK_NAME_RE, MAX_TTL_MIN, canonicalLockName, parseTtlFlag } from "../lib/pushLockRules";

type Raw = { ok: boolean; status: number; data: unknown };
type Env = Record<string, string | undefined>;
export type LockDeps = {
  api: (method: string, path: string, body?: unknown) => Promise<unknown>;
  apiRaw: (method: string, path: string, body?: unknown) => Promise<Raw>;
  log: (line: string) => void;
  env?: Env;
};

type LockView = {
  name: string;
  active: boolean;
  holderName: string;
  holderSession: string | null;
  cwd: string | null;
  branch: string | null;
  note: string | null;
  takenAt: string;
  expiresAt: string;
  ageMin: number;
  remainingMin: number;
  mine: boolean;
};

export const lockPath = (name: string) => `/api/locks/${encodeURIComponent(name)}`;

/** 이름을 정규형으로 맞춰 검증한다(teamspace-main·TeamSpace_main → teamspace/main). 서버도 같은 정규형을 쓴다. */
export function checkName(raw: string | undefined): string {
  if (!raw || !raw.trim()) throw new Error("잠금 이름이 필요합니다 (예: banjang/develop · teamspace/main · deploy/teamspace).");
  const name = canonicalLockName(raw);
  if (!LOCK_NAME_RE.test(name)) throw new Error(`잠금 이름 형식이 아닙니다: '${raw}' — 영문·숫자 단어를 / - _ : . 공백으로 잇고, 81자 이내(정규형: '${name}').`);
  return name;
}

export function ttlOf(flag: string | undefined): number | undefined {
  if (flag === undefined) return undefined;
  const m = parseTtlFlag(flag);
  if (m === null || m < 1 || m > MAX_TTL_MIN) throw new Error(`--ttl 은 30m · 2h · 1h30m 처럼 1분~4시간입니다: '${flag}'`);
  return m;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** 보유자 정보: Claude 세션 id(env) + CLI 를 부른 폴더와 그 브랜치. pnpm 은 스크립트를 패키지 루트에서 돌리므로 INIT_CWD 가 원래 폴더. */
export function holderContext(env: Env, cwdFlag?: string) {
  const cwd = resolve(cwdFlag ?? env.INIT_CWD ?? process.cwd());
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const session = env.CLAUDE_SESSION_ID || env.CLAUDE_CODE_SESSION_ID || undefined;
  return { session, cwd, branch: branch && branch !== "HEAD" ? branch : undefined };
}

export function describeLock(l: LockView): string {
  return [
    l.name,
    `${l.holderName}${l.mine ? " (나)" : ""}`,
    `${l.ageMin}분 전 · ${l.remainingMin}분 남음`,
    l.branch ?? "-",
    l.note ?? "",
  ].join("\t");
}

function errorOf(r: Raw): string {
  const d = r.data as { error?: string } | undefined;
  return d?.error ?? `HTTP ${r.status}`;
}

export async function lockTake(deps: LockDeps, name: string | undefined, o: { ttl?: string; note?: string; cwd?: string }) {
  const n = checkName(name);
  const h = holderContext(deps.env ?? process.env, o.cwd);
  const r = await deps.apiRaw("POST", lockPath(n), { ttlMinutes: ttlOf(o.ttl), note: o.note, ...h });
  if (!r.ok) throw new Error(errorOf(r));
  const { result, lock } = r.data as { result: "taken" | "refreshed"; lock: LockView };
  deps.log(`${result === "taken" ? "잡음" : "연장(이미 내 잠금)"}: ${lock.name} — ${lock.remainingMin}분 뒤 만료 (${new Date(lock.expiresAt).toLocaleTimeString("ko-KR")})`);
}

export async function lockExtend(deps: LockDeps, name: string | undefined, o: { ttl?: string }) {
  const n = checkName(name);
  const h = holderContext(deps.env ?? process.env);
  const r = await deps.apiRaw("PATCH", lockPath(n), { ttlMinutes: ttlOf(o.ttl), session: h.session });
  if (!r.ok) throw new Error(errorOf(r));
  const { lock } = r.data as { lock: LockView };
  deps.log(`연장: ${lock.name} — ${lock.remainingMin}분 뒤 만료`);
}

export async function lockRelease(deps: LockDeps, name: string | undefined) {
  const n = checkName(name);
  const h = holderContext(deps.env ?? process.env);
  const r = await deps.apiRaw("DELETE", `${lockPath(n)}${h.session ? `?session=${encodeURIComponent(h.session)}` : ""}`);
  if (!r.ok) throw new Error(errorOf(r));
  const d = r.data as { released: boolean; reason?: string };
  deps.log(d.released ? `해제: ${n}` : `${n}: ${d.reason ?? "해제할 잠금이 없습니다."}`);
}

export async function lockLs(deps: LockDeps) {
  const h = holderContext(deps.env ?? process.env);
  const { locks } = (await deps.api("GET", `/api/locks${h.session ? `?session=${encodeURIComponent(h.session)}` : ""}`)) as { locks: LockView[] };
  if (locks.length === 0) return deps.log("살아 있는 잠금이 없습니다.");
  for (const l of locks) deps.log(describeLock(l));
}

type LiveSession = {
  externalId: string;
  repo: string | null;
  branch: string | null;
  worktree: string | null;
  cwd: string | null;
  agentName: string | null;
  lastSeenAt: string;
  tasks: { id: string; title: string }[];
};

const ago = (iso: string, now = Date.now()) => {
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  return m < 60 ? `${m}분 전` : `${Math.floor(m / 60)}시간 ${m % 60}분 전`;
};

export async function sessionsLive(deps: LockDeps) {
  const r = (await deps.api("GET", "/api/sessions/live")) as { windowHours: number; sessions: LiveSession[]; locks: LockView[] };
  deps.log(`라이브 세션 ${r.sessions.length}개 (마지막 활동 ${r.windowHours}시간 안)`);
  for (const s of r.sessions) {
    const where = s.repo ? `${s.repo}${s.branch ? `@${s.branch}` : ""}${s.worktree ? ` [${s.worktree}]` : ""}` : (s.cwd ?? "-");
    const tasks = s.tasks.length ? s.tasks.map((t) => t.title).join(", ") : "-";
    deps.log([s.agentName ?? "-", where, ago(s.lastSeenAt), tasks, s.externalId.slice(0, 8)].join("\t"));
  }
  deps.log(`\n잠금 ${r.locks.length}개`);
  for (const l of r.locks) deps.log(describeLock(l));
}

/* ── pre-push 설치기 ─────────────────────────────────────────────────────── */

export const HOOK_MARKER = "teamspace push-lock";
export const HOOK_SCRIPT = "teamspace-pre-push.mjs";
export const CHAINED = "pre-push.teamspace-chained";

/** 래퍼: stdin 을 한 번 받아 우리 훅(경고만, 실패 무시)에 먼저 주고, 기존 훅이 있으면 같은 입력으로 이어 부른다(그 결과가 최종). */
export function wrapperScript(): string {
  return `#!/bin/sh
# ${HOOK_MARKER} — \`pnpm ws lock install-hook\` 가 설치. 잠금 경고만 하고 푸시는 막지 않는다.
# 원래 있던 pre-push 는 ${CHAINED} 로 옮겨 두고 아래에서 이어 부른다(그 종료 코드가 최종 결과).
HOOK_DIR=$(dirname "$0")
INPUT=$(cat)
if command -v node >/dev/null 2>&1 && [ -f "$HOOK_DIR/${HOOK_SCRIPT}" ]; then
  printf '%s\\n' "$INPUT" | node "$HOOK_DIR/${HOOK_SCRIPT}" "$@" || true
fi
if [ -x "$HOOK_DIR/${CHAINED}" ]; then
  printf '%s\\n' "$INPUT" | "$HOOK_DIR/${CHAINED}" "$@"
  exit $?
fi
exit 0
`;
}

/**
 * <git-common-dir>/hooks 에 pre-push 경고 훅을 설치(재실행하면 훅 본문만 갱신).
 * core.hooksPath 가 설정된 레포는 건드리지 않고 방법을 알려 준다(공유 훅 폴더를 덮어쓰지 않기 위해).
 */
export function installPrePushHook(repoPath: string, hookSource: string): { hooksDir: string; chained: boolean; updated: boolean } {
  const repo = resolve(repoPath);
  const common = git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common) throw new Error(`git 저장소가 아닙니다: ${repo}`);
  const hooksPath = git(repo, ["config", "--get", "core.hooksPath"]);
  if (hooksPath) {
    throw new Error(
      `이 레포는 core.hooksPath=${hooksPath} 를 씁니다 — 공유 훅 폴더를 덮어쓰지 않으려고 설치를 멈췄습니다.\n` +
        `직접 붙이려면: ${hookSource} 를 그 폴더에 ${HOOK_SCRIPT} 로 복사하고, 그 폴더의 pre-push 맨 앞에서\n` +
        `  stdin 을 그대로 넘겨 'node "$(dirname "$0")/${HOOK_SCRIPT}" "$@" || true' 를 부르세요(종료 코드는 무시).`,
    );
  }
  const hooksDir = join(common, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  copyFileSync(hookSource, join(hooksDir, HOOK_SCRIPT));
  chmodSync(join(hooksDir, HOOK_SCRIPT), 0o644);

  const prePush = join(hooksDir, "pre-push");
  const chainedPath = join(hooksDir, CHAINED);
  let updated = false;
  if (existsSync(prePush)) {
    const cur = readFileSync(prePush, "utf8");
    if (cur.includes(HOOK_MARKER)) {
      updated = true;
    } else {
      if (existsSync(chainedPath)) throw new Error(`${chainedPath} 가 이미 있어 기존 pre-push 를 옮길 수 없습니다 — 직접 확인하세요.`);
      renameSync(prePush, chainedPath);
    }
  }
  writeFileSync(prePush, wrapperScript());
  chmodSync(prePush, 0o755);
  return { hooksDir, chained: existsSync(chainedPath), updated };
}

export function lockInstallHook(deps: LockDeps, o: { repo?: string; hookSource: string }) {
  const env = deps.env ?? process.env;
  const r = installPrePushHook(o.repo ?? env.INIT_CWD ?? process.cwd(), o.hookSource);
  deps.log(`${r.updated ? "갱신" : "설치"}: ${r.hooksDir}/pre-push${r.chained ? ` (기존 훅은 ${CHAINED} 로 이어 부름)` : ""}`);
  deps.log("푸시할 때 남이 잡은 <repo>/<branch> 잠금이 있으면 경고만 하고 푸시는 그대로 진행합니다.");
}
