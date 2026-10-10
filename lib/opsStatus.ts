import path from "node:path";
import os from "node:os";
import { promises as fsp } from "node:fs";
import { DATA_DIR } from "@/lib/dataDir";
import { buildTodayCost } from "@/lib/llmCostBlock";

/* =====================================================================
   운영 상태(F8) — health·백업·디스크·AI 비용을 한 번에. 관리자 전용(경로가 드러난다).
   collectOpsStatus 는 의존성을 주입받아 테스트한다. evaluateOps 는 순수 함수.
   ===================================================================== */

export type OpsStatus = {
  checkedAt: string;
  health: { db: boolean; worker: boolean; workerAgeSec: number | null };
  backup: {
    dir: string;
    latest: string | null;
    ageHours: number | null;
    sizeBytes: number | null;
    /** 가장 새 폴더가 아직 쓰는 중(덤프 없음 또는 파일이 2분 안에 바뀜)이라 건너뛰고 직전 완성본을 보고했다. */
    inProgress?: boolean;
    /** 폴더 이름의 시각이 현재보다 미래 — 서버 시계가 어긋났거나 이름이 잘못됐다. ageHours 는 0 으로 두되 이 플래그로 드러낸다. */
    clockSkew?: boolean;
    /** 가장 새 폴더에 덤프가 없고 1시간 넘게 아무 파일도 안 바뀌었다 — 만들다 죽은 실패 시도. 직전 완성본이 latest 가 된다. */
    lastAttemptFailed?: boolean;
    failedDir?: string;
  };
  /** path = 실제로 잰 경로, requestedPath = 데이터 디렉토리. 데이터 폴더가 아직 없으면 가장 가까운 상위 폴더로 재서 둘이 다르다. */
  disk: { path: string; requestedPath: string; freeBytes: number; totalBytes: number; freeRatio: number } | null;
  llm: { todayTokens: number | null; todayUsd: number | null; budgetTokens: number; exceeded: boolean };
  build: { version: string; buildId: string | null };
};

export type OpsWarning = {
  level: "warn" | "crit";
  code: "backup_stale" | "backup_missing" | "backup_in_progress" | "backup_failed" | "backup_clock_skew" | "disk_low" | "llm_budget" | "worker_down" | "db_down";
  message: string;
};

export type OpsDeps = {
  fs: {
    readdir: (p: string) => Promise<string[]>;
    stat: (p: string) => Promise<{ size: number; mtimeMs: number; isFile: () => boolean }>;
    statfs: (p: string) => Promise<{ bsize: number; blocks: number; bavail: number }>;
    readFile: (p: string) => Promise<string>;
  };
  now: () => Date;
  /** db 가 안 닿으면 throw 하지 말고 db:false 로 */
  heartbeat: () => Promise<{ db: boolean; at: Date | null }>;
  usedTokensToday: () => Promise<number>;
  dailyBudgetTokens: () => number;
  /** 오늘 추정 $ 를 byDay 로 — 워크스페이스 단위 */
  usageByDay: () => Promise<{ day: string; usd?: number | null }[]>;
  dayKey: (d: Date) => string;
  env: Record<string, string | undefined>;
  dataDir: string;
  cwd: string;
};

export const WORKER_FRESH_SEC = 90;
const BACKUP_NAME = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;
const LIST_CAP = 50;
/** backup.sh 가 맨 먼저 쓰는 DB 덤프 — 이게 없으면 그 폴더는 아직 만드는 중이다. */
const BACKUP_DUMP = "teamspace.dump";
/** 파일이 이만큼 안 바뀌어야 완성으로 본다(tar 가 아직 쓰는 중일 수 있다). */
export const BACKUP_SETTLE_MS = 2 * 60_000;
/** 덤프 없는 폴더가 이 시간 넘게 안 바뀌면 진행 중이 아니라 실패한 시도다. */
export const BACKUP_STALE_MS = 60 * 60_000;
/** backup.sh 는 `pg_dump > teamspace.dump` 라 덤프가 실패하면 0바이트 파일이 남는다 — 이보다 작으면 덤프 없음으로 본다. */
export const MIN_DUMP_BYTES = 1024;

export const defaultFs: OpsDeps["fs"] = {
  readdir: (p) => fsp.readdir(p),
  stat: (p) => fsp.stat(p),
  statfs: async (p) => {
    const s = await fsp.statfs(p);
    return { bsize: Number(s.bsize), blocks: Number(s.blocks), bavail: Number(s.bavail) };
  },
  readFile: (p) => fsp.readFile(p, "utf8"),
};

/** 백업 폴더명(로컬 시각, scripts/backup.sh 의 date 형식) → Date. 형식이 아니면 null. */
export function parseBackupName(name: string): Date | null {
  const m = BACKUP_NAME.exec(name);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const dt = new Date(y, mo - 1, d, h, mi, s);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

type BackupInfo = { size: number; newestMtimeMs: number; hasDump: boolean };

/** 폴더 내용 요약. 폴더를 못 읽으면 null. */
async function inspectBackupDir(deps: OpsDeps, sub: string): Promise<BackupInfo | null> {
  let files: string[];
  try {
    files = (await deps.fs.readdir(sub)).slice(0, LIST_CAP);
  } catch {
    return null;
  }
  let size = 0;
  let newestMtimeMs = 0;
  let dumpSize = 0;
  for (const f of files) {
    try {
      const st = await deps.fs.stat(path.join(sub, f));
      if (!st.isFile()) continue;
      size += st.size;
      if (f === BACKUP_DUMP) dumpSize = st.size;
      newestMtimeMs = Math.max(newestMtimeMs, st.mtimeMs);
    } catch { /* 지워진 파일은 건너뜀 */ }
  }
  return { size, newestMtimeMs, hasDump: dumpSize >= MIN_DUMP_BYTES };
}

async function collectBackup(deps: OpsDeps, now: Date): Promise<OpsStatus["backup"]> {
  const dir = deps.env.TEAMSPACE_BACKUP_DIR?.trim() || path.join(os.homedir(), "Backups", "teamspace");
  const empty: OpsStatus["backup"] = { dir, latest: null, ageHours: null, sizeBytes: null };
  let names: string[];
  try {
    names = await deps.fs.readdir(dir);
  } catch {
    return empty;
  }
  const sorted = names.filter((n) => BACKUP_NAME.test(n)).sort().reverse();
  if (sorted.length === 0) return empty;

  let latest = sorted[0];
  let info = await inspectBackupDir(deps, path.join(dir, latest));
  let inProgress = false;
  let failedDir: string | undefined;
  // 직전 완성본 = 새 쪽에서 거슬러 올라가며 처음 만나는 덤프 있는 폴더. 덤프 없는 폴더(연속 실패)는 건너뛴다.
  const previousComplete = async (): Promise<{ name: string; info: BackupInfo | null } | null> => {
    for (const name of sorted.slice(1, LIST_CAP + 1)) {
      const i = await inspectBackupDir(deps, path.join(dir, name));
      if (i?.hasDump) return { name, info: i };
    }
    return null;
  };
  // 파일이 하나도 없으면 mtime 을 알 수 없다 → 폴더 자신의 mtime, 그것도 못 구하면 0(=알 수 없음, 실패로 단정하지 않음).
  if (info && !info.hasDump && info.newestMtimeMs === 0) {
    try { info.newestMtimeMs = (await deps.fs.stat(path.join(dir, latest))).mtimeMs; } catch { /* 알 수 없음 */ }
  }
  // 덤프도 없고 1시간 넘게 멈춘 폴더 = 실패한 시도. 진행 중으로 영원히 가리지 않고 직전 완성본을 쓴다.
  if (info && !info.hasDump && info.newestMtimeMs > 0 && now.getTime() - info.newestMtimeMs > BACKUP_STALE_MS) {
    failedDir = latest;
    const prev = await previousComplete();
    if (!prev) return { ...empty, lastAttemptFailed: true, failedDir };
    latest = prev.name;
    info = prev.info;
  }
  // 지금 만드는 중인 폴더는 불완전해서 크기·나이를 그대로 믿으면 "방금 백업 성공" 으로 오판한다 → 직전 완성본을 쓴다.
  if (!failedDir && info && (!info.hasDump || now.getTime() - info.newestMtimeMs < BACKUP_SETTLE_MS)) {
    inProgress = true;
    const prev = await previousComplete();
    if (!prev) return { ...empty, inProgress: true };
    latest = prev.name;
    info = prev.info;
  }

  // 이름이 BACKUP_NAME 을 통과했으므로 시각은 늘 이름에서 나온다(mtime 폴백 불필요).
  const at = parseBackupName(latest);
  const rawAgeMs = at ? now.getTime() - at.getTime() : null;
  const out: OpsStatus["backup"] = {
    dir,
    latest,
    ageHours: rawAgeMs === null ? null : Math.max(0, rawAgeMs / 3_600_000),
    sizeBytes: info ? info.size : null,
  };
  if (inProgress) out.inProgress = true;
  if (failedDir) {
    out.lastAttemptFailed = true;
    out.failedDir = failedDir;
  }
  if (rawAgeMs !== null && rawAgeMs < 0) out.clockSkew = true;
  return out;
}

async function collectDisk(deps: OpsDeps): Promise<OpsStatus["disk"]> {
  // 데이터 폴더가 아직 안 만들어졌어도(첫 기동 전) 같은 볼륨의 가장 가까운 상위 폴더로 잰다.
  let p = deps.dataDir;
  for (let i = 0; i < 64; i++) {
    try {
      const s = await deps.fs.statfs(p);
      const totalBytes = s.blocks * s.bsize;
      const freeBytes = s.bavail * s.bsize;
      return { path: p, requestedPath: deps.dataDir, freeBytes, totalBytes, freeRatio: totalBytes > 0 ? freeBytes / totalBytes : 0 };
    } catch {
      const up = path.dirname(p);
      if (up === p) return null;
      p = up;
    }
  }
  return null;
}

async function collectBuild(deps: OpsDeps): Promise<OpsStatus["build"]> {
  let version = "unknown";
  try { version = (JSON.parse(await deps.fs.readFile(path.join(deps.cwd, "package.json"))) as { version?: string }).version ?? "unknown"; } catch { /* 읽을 수 없으면 unknown */ }
  let buildId: string | null = null;
  try { buildId = (await deps.fs.readFile(path.join(deps.cwd, ".next", "BUILD_ID"))).trim() || null; } catch { /* dev 서버 등 */ }
  return { version, buildId };
}

export async function collectOpsStatus(deps: OpsDeps): Promise<OpsStatus> {
  const now = deps.now();
  const [hb, backup, disk, build, used, byDay] = await Promise.all([
    deps.heartbeat().catch(() => ({ db: false, at: null as Date | null })),
    collectBackup(deps, now),
    collectDisk(deps),
    collectBuild(deps),
    deps.usedTokensToday().catch(() => null as number | null),
    deps.usageByDay().catch(() => []),
  ]);
  const workerAgeSec = hb.at ? Math.max(0, Math.round((now.getTime() - hb.at.getTime()) / 1000)) : null;
  return {
    checkedAt: now.toISOString(),
    health: { db: hb.db, worker: hb.db && workerAgeSec !== null && workerAgeSec < WORKER_FRESH_SEC, workerAgeSec },
    backup,
    disk,
    llm: buildTodayCost(used, deps.dailyBudgetTokens(), byDay, deps.dayKey(now)),
    build,
  };
}

export function evaluateOps(s: OpsStatus): OpsWarning[] {
  const w: OpsWarning[] = [];
  if (!s.health.db) w.push({ level: "crit", code: "db_down", message: "DB 에 연결할 수 없습니다." });
  else if (!s.health.worker) {
    w.push({
      level: "warn",
      code: "worker_down",
      message: s.health.workerAgeSec === null ? "워커 하트비트가 아직 없습니다." : `워커 하트비트가 ${s.health.workerAgeSec}초 전입니다(${WORKER_FRESH_SEC}초 초과).`,
    });
  }
  if (s.backup.clockSkew) {
    w.push({ level: "warn", code: "backup_clock_skew", message: "백업 폴더 시각이 현재보다 미래입니다(서버 시계 확인)." });
  }
  if (s.backup.lastAttemptFailed) {
    w.push({ level: "warn", code: "backup_failed", message: `마지막 백업 시도가 실패했습니다(${s.backup.failedDir}, 덤프 없음)` });
  }
  if (s.backup.latest === null || s.backup.ageHours === null) {
    // 첫 백업이 진행 중이면 '없음'이 아니라 '만드는 중' — crit 로 오탐하지 않는다.
    if (s.backup.inProgress) w.push({ level: "warn", code: "backup_in_progress", message: "첫 백업이 진행 중입니다(완성된 백업이 아직 없습니다)." });
    else w.push({ level: "crit", code: "backup_missing", message: "백업을 찾을 수 없습니다." });
  } else if (s.backup.ageHours > 72) {
    w.push({ level: "crit", code: "backup_stale", message: `마지막 백업이 ${Math.floor(s.backup.ageHours)}시간 전입니다(72시간 초과).` });
  } else if (s.backup.ageHours > 30) {
    w.push({ level: "warn", code: "backup_stale", message: `마지막 백업이 ${Math.floor(s.backup.ageHours)}시간 전입니다(30시간 초과).` });
  }
  if (s.disk) {
    const pct = Math.round(s.disk.freeRatio * 1000) / 10;
    if (s.disk.freeRatio < 0.07) w.push({ level: "crit", code: "disk_low", message: `디스크 여유가 ${pct}% 입니다(7% 미만).` });
    else if (s.disk.freeRatio < 0.15) w.push({ level: "warn", code: "disk_low", message: `디스크 여유가 ${pct}% 입니다(15% 미만).` });
  }
  if (s.llm.exceeded) w.push({ level: "warn", code: "llm_budget", message: "오늘 AI 토큰 예산을 넘었습니다." });
  return w;
}

/** 라우트용 실제 의존성. 테스트는 collectOpsStatus 에 가짜를 직접 넣는다. */
export function realDeps(over: Pick<OpsDeps, "heartbeat" | "usedTokensToday" | "dailyBudgetTokens" | "usageByDay" | "dayKey">): OpsDeps {
  return { fs: defaultFs, now: () => new Date(), env: process.env, dataDir: DATA_DIR, cwd: process.cwd(), ...over };
}
