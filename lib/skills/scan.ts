/* =====================================================================
   스킬 레지스트리 — SKILL.md 사본 스캔 (읽기 전용).

   같은 스킬이 메인 레포·워크트리·전역(~/.claude/skills)·플러그인에 흩어져 있고,
   워크트리 사본은 만들어진 시점에 멈춘다. 서버(같은 사용자 계정)가 디스크를 훑어
   사본마다 이름·위치 종류·레포/브랜치·내용 해시를 모은다.

   경로는 전부 env 로 받는다(OSS 이식성). 비어 있으면 기능 자체를 숨긴다.
     SKILL_SCAN_ROOTS       콜론 구분 루트 목록(앞 `~` 는 홈으로 펼침)
     SKILL_SCAN_MAX_DEPTH   루트 아래로 내려갈 폴더 깊이(기본 7, 1~12)
     SKILL_SCAN_TIME_BUDGET_MS  스캔 시간 한도(기본 15000, 500~120000)

   가지치기(부하가 높은 서버에서도 빨리 끝나도록 — 폴더 수가 곧 비용이다):
     - 이름이 SKIP_DIRS 인 폴더는 내려가지 않는다(의존성·빌드 산출물·캐시·네이티브 프로젝트).
     - 레포 체크아웃 폴더(`.git` 이 있는 곳)에서는 `.claude`·`.agents` 만 내려간다 —
       레포 스킬은 거기 있고, 워크트리는 `.claude/worktrees/<이름>` 이라 같은 규칙으로 다시 잘린다.
       단 루트에 `.claude-plugin` 이 있는 레포(플러그인·마켓 원본)는 통째로 훑는다.
     - `~/.claude` 바로 아래의 세션 기록·캐시 폴더(HOME_CLAUDE_SKIP)는 건너뛴다.
     - `~/.claude/plugins` 아래는 마켓 클론도 git 레포지만 레포 가지치기를 하지 않는다.

   심볼릭 링크는 따라가지 않는다(lstat 기준 — 순환·중복 방지).
   git 관계는 셸 없이 파일로 판정한다: `.git` 이 폴더면 메인 체크아웃,
   파일(`gitdir: …/.git/worktrees/<이름>`)이면 연결된 워크트리.

   파싱·분류는 순수 함수(테스트: scan.test.ts), 입출력은 scanSkills 하나.
   ===================================================================== */

import { createHash } from "node:crypto";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export const DEFAULT_MAX_DEPTH = 7;
export const MAX_DEPTH_LIMIT = 12;
export const MAX_COPIES = 5000;
export const MAX_DIRS = 200_000;
export const TIME_BUDGET_MS = 15_000;
export const TIME_BUDGET_MIN_MS = 500;
export const TIME_BUDGET_MAX_MS = 120_000;
export const MAX_SKILL_BYTES = 2 * 1024 * 1024;

/** 내려가지 않는 폴더 이름. 빌드 산출물·의존성·VCS 내부·캐시·네이티브 프로젝트. */
export const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "coverage", ".turbo", ".cache", ".pnpm-store",
  "Library", "ios", "android", "Pods", ".venv", "venv", "__pycache__", "target", "out", "tmp",
]);
/** 레포 체크아웃 폴더에서 내려가는 자식(그 밖은 건너뜀). */
export const REPO_DESCEND = new Set([".claude", ".agents"]);
/** `~/.claude` 바로 아래에서 건너뛰는 폴더 — 세션 기록·캐시라 스킬이 없고 폴더 수만 많다. */
export const HOME_CLAUDE_SKIP = new Set([
  "projects", "file-history", "shell-snapshots", "session-env", "sessions", "debug", "todos", "paste-cache",
  "cache", "backups", "downloads", "uploads", "tasks", "teams", "jobs", "statsig", "telemetry", "ide", "chrome", "state", "feedback",
]);
/** 내려가지 않는 경로 꼬리(폴더 이름만으로는 너무 넓은 것). */
const SKIP_SUFFIXES = [`${sep}app${sep}generated`];

/* ── 설정 ─────────────────────────────────────────────────────────────── */

export type SkillScanConfig = { roots: string[]; maxDepth: number; home: string; timeBudgetMs?: number };

export function expandHome(p: string, home = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/** env → 설정. 루트가 하나도 없으면 null(기능 숨김). 상대 경로 루트는 버린다. */
export function skillScanConfig(env: Record<string, string | undefined> = process.env, home = homedir()): SkillScanConfig | null {
  const roots = (env.SKILL_SCAN_ROOTS ?? "")
    .split(":")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => expandHome(s, home))
    .filter((s) => isAbsolute(s))
    .map((s) => resolve(s));
  const uniq = [...new Set(roots)];
  if (uniq.length === 0) return null;
  const n = Math.floor(Number(env.SKILL_SCAN_MAX_DEPTH));
  const maxDepth = Number.isFinite(n) && n >= 1 ? Math.min(MAX_DEPTH_LIMIT, n) : DEFAULT_MAX_DEPTH;
  const b = Math.floor(Number(env.SKILL_SCAN_TIME_BUDGET_MS));
  const timeBudgetMs = Number.isFinite(b) && b > 0 ? Math.min(TIME_BUDGET_MAX_MS, Math.max(TIME_BUDGET_MIN_MS, b)) : TIME_BUDGET_MS;
  return { roots: uniq, maxDepth, home, timeBudgetMs };
}

/* ── 파싱 (순수) ──────────────────────────────────────────────────────── */

const unquote = (s: string) => {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1).trim();
  return t;
};

/** SKILL.md 앞머리(--- … ---)에서 name·description. description 은 첫 줄만. */
export function parseFrontmatter(text: string): { name: string | null; description: string | null } {
  const norm = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!norm.startsWith("---\n")) return { name: null, description: null };
  const end = norm.indexOf("\n---", 4);
  if (end < 0) return { name: null, description: null };
  const lines = norm.slice(4, end).split("\n");
  let name: string | null = null;
  let description: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    // 블록 스칼라(| 또는 >) — 다음 들여쓴 줄이 첫 줄
    if (/^[|>][+-]?$/.test(val)) {
      const next = lines.slice(i + 1).find((l) => /^\s+\S/.test(l));
      val = next ? next.trim() : "";
    }
    val = unquote(val);
    if (key === "name" && val && name === null) name = val;
    if (key === "description" && val && description === null) description = val.split("\n")[0].trim();
  }
  return { name, description };
}

/** `.git` 파일 내용(`gitdir: <경로>`) → 절대 gitdir. 상대 경로면 base 기준. */
export function parseGitDirPointer(text: string, base: string): string | null {
  const m = /^gitdir:\s*(.+)$/m.exec(text);
  if (!m) return null;
  const p = m[1].trim();
  return isAbsolute(p) ? resolve(p) : resolve(base, p);
}

/** 워크트리 gitdir(`<메인>/.git/worktrees/<이름>`) → 메인 체크아웃 경로. 워크트리가 아니면 null(서브모듈 등). */
export function mainRepoFromGitDir(gitdir: string): string | null {
  const norm = gitdir.replace(/\\/g, "/").replace(/\/+$/, "");
  const m = /^(.*)\/\.git\/worktrees\/[^/]+$/.exec(norm);
  return m ? m[1] || "/" : null;
}

/** HEAD 내용 → 브랜치 이름. 분리된 HEAD 면 `(detached abc1234)`. */
export function branchFromHead(text: string): string | null {
  const t = text.trim();
  const m = /^ref:\s*refs\/heads\/(.+)$/.exec(t);
  if (m) return m[1];
  if (/^[0-9a-f]{7,64}$/i.test(t)) return `(detached ${t.slice(0, 7)})`;
  return null;
}

export type LocationKind = "repo" | "worktree" | "global" | "plugin" | "other";
export type GitCtx = { kind: "repo" | "worktree"; checkout: string; mainRepo: string; repo: string; branch: string | null };

/**
 * 위치 종류 + 묶음 범위. 전역·플러그인 경로가 git 판정보다 먼저다
 * (플러그인 마켓플레이스는 그 자체가 git 클론이라 레포로 잘못 잡힌다).
 *   plugin 범위 = `plugin:<마켓>/<플러그인 안 경로>` — 같은 플러그인의 설치 버전들(cache/<마켓>/<플러그인>/<버전>/…)과
 *   마켓 원본(marketplaces/<마켓>/plugins|external_plugins/<플러그인>/…)은 한 묶음, 이름이 같아도 다른 플러그인·변형
 *   (discord/telegram 의 access, figma 의 skills-figquery 등)은 다른 묶음.
 */
export function classifyLocation(path: string, git: GitCtx | null, home: string): { kind: LocationKind; scope: string } {
  const claude = join(home, ".claude");
  const under = (dir: string) => path === dir || path.startsWith(dir + sep);
  const plugins = join(claude, "plugins");
  if (under(plugins)) return { kind: "plugin", scope: pluginScope(path.slice(plugins.length + 1).split(sep)) };
  if (under(join(claude, "skills"))) return { kind: "global", scope: "global" };
  if (git) return { kind: git.kind, scope: `repo:${git.repo}` };
  return { kind: "other", scope: "other" };
}

const VERSION_SEG = /^(v?\d+(\.\d+)+.*|[0-9a-f]{7,40})$/i;

/** ~/.claude/plugins 아래 상대 경로 조각(…/<스킬 폴더>/SKILL.md) → `plugin:<마켓>[/<경로>]`. */
export function pluginScope(rest: string[]): string {
  const kind = rest[0];
  if ((kind !== "cache" && kind !== "marketplaces") || rest.length < 4) return `plugin:${rest[0] ?? ""}`;
  const market = rest[1];
  let mid = rest.slice(2, -2);
  if (kind === "cache" && mid.length >= 2 && VERSION_SEG.test(mid[1])) mid = [mid[0], ...mid.slice(2)];
  if (kind === "marketplaces" && (mid[0] === "plugins" || mid[0] === "external_plugins")) mid = mid.slice(1);
  if (mid.length && mid[mid.length - 1] === "skills") mid = mid.slice(0, -1);
  return mid.length ? `plugin:${market}/${mid.join("/")}` : `plugin:${market}`;
}

export const shortHash = (s: string, len = 12) => createHash("sha1").update(s).digest("hex").slice(0, len);

/** 표시용 경로: 홈을 `~` 로. */
export function displayPath(p: string, home: string): string {
  if (p === home) return "~";
  return p.startsWith(home + sep) ? `~${p.slice(home.length)}` : p;
}

/* ── 스캔 (입출력) ────────────────────────────────────────────────────── */

export type SkillCopy = {
  id: string;
  path: string;
  name: string;
  description: string | null;
  sha256: string;
  lines: number;
  bytes: number;
  mtime: string;
  kind: LocationKind;
  scope: string;
  repo: string | null;
  branch: string | null;
  /** 레포/워크트리 체크아웃 폴더 */
  checkout: string | null;
  root: string;
};

export type ScanResult = {
  copies: SkillCopy[];
  truncated: boolean;
  truncatedReason: "max_copies" | "max_dirs" | "time_budget" | null;
  dirsVisited: number;
  errors: number;
  durationMs: number;
  roots: { path: string; exists: boolean }[];
  maxDepth: number;
};

async function readText(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

/** dir 에 `.git`(폴더 또는 파일)이 있으면 그 git 문맥. 없으면 null. */
async function gitCtxAt(dir: string, gitIsDir: boolean): Promise<GitCtx | null> {
  if (gitIsDir) {
    const head = await readText(join(dir, ".git", "HEAD"));
    return { kind: "repo", checkout: dir, mainRepo: dir, repo: basename(dir), branch: head ? branchFromHead(head) : null };
  }
  const ptr = await readText(join(dir, ".git"));
  const gitdir = ptr ? parseGitDirPointer(ptr, dir) : null;
  if (!gitdir) return null;
  const head = await readText(join(gitdir, "HEAD"));
  const branch = head ? branchFromHead(head) : null;
  const main = mainRepoFromGitDir(gitdir);
  if (main) return { kind: "worktree", checkout: dir, mainRepo: main, repo: basename(main), branch };
  // 서브모듈 등 — 자기 폴더를 레포로 본다
  return { kind: "repo", checkout: dir, mainRepo: dir, repo: basename(dir), branch };
}

/** 루트 자신 또는 그 위 조상의 git 문맥(루트가 레포 안쪽일 때). */
async function ancestorGitCtx(start: string): Promise<GitCtx | null> {
  let dir = start;
  for (let i = 0; i < 64; i++) {
    try {
      const st = await lstat(join(dir, ".git"));
      if (st.isDirectory() || st.isFile()) return gitCtxAt(dir, st.isDirectory());
    } catch {
      /* 없음 — 위로 */
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

type Job = { dir: string; depth: number; git: GitCtx | null; root: string };

export type ScanLimits = { maxCopies?: number; maxDirs?: number; timeBudgetMs?: number; concurrency?: number; now?: () => number };

export async function scanSkills(cfg: SkillScanConfig, limits: ScanLimits = {}): Promise<ScanResult> {
  const now = limits.now ?? Date.now;
  const started = now();
  const maxCopies = limits.maxCopies ?? MAX_COPIES;
  const maxDirs = limits.maxDirs ?? MAX_DIRS;
  const budget = limits.timeBudgetMs ?? cfg.timeBudgetMs ?? TIME_BUDGET_MS;
  const homeClaude = join(cfg.home, ".claude");
  const homePlugins = join(homeClaude, "plugins");
  const underPlugins = (p: string) => p === homePlugins || p.startsWith(homePlugins + sep);
  const concurrency = limits.concurrency ?? 16;

  const copies: SkillCopy[] = [];
  const seenPaths = new Set<string>();
  const roots: ScanResult["roots"] = [];
  const queue: Job[] = [];
  let dirsVisited = 0;
  let reserved = 0;
  let errors = 0;
  let truncatedReason: ScanResult["truncatedReason"] = null;

  for (const root of cfg.roots) {
    let exists = false;
    try {
      exists = (await stat(root)).isDirectory();
    } catch {
      exists = false;
    }
    roots.push({ path: root, exists });
    // 루트 자신의 .git 은 readdir 단계에서 다시 보므로, 조상만 본다
    if (exists) queue.push({ dir: root, depth: 0, git: await ancestorGitCtx(dirname(root)), root });
  }

  const recordSkill = async (file: string, job: Job, git: GitCtx | null) => {
    if (seenPaths.has(file)) return;
    seenPaths.add(file);
    try {
      const st = await lstat(file);
      if (!st.isFile() || st.size > MAX_SKILL_BYTES) {
        errors++;
        return;
      }
      const buf = await readFile(file);
      const text = buf.toString("utf8");
      const fm = parseFrontmatter(text);
      const { kind, scope } = classifyLocation(file, git, cfg.home);
      const isRepo = kind === "repo" || kind === "worktree";
      copies.push({
        id: shortHash(file),
        path: file,
        name: fm.name ?? basename(dirname(file)),
        description: fm.description,
        sha256: createHash("sha256").update(buf).digest("hex"),
        lines: text.length === 0 ? 0 : text.replace(/\n$/, "").split("\n").length,
        bytes: st.size,
        mtime: st.mtime.toISOString(),
        kind,
        scope,
        repo: isRepo && git ? git.repo : null,
        branch: isRepo && git ? git.branch : null,
        checkout: isRepo && git ? git.checkout : null,
        root: job.root,
      });
    } catch {
      errors++;
    }
  };

  const work = async (job: Job) => {
    let entries;
    try {
      entries = await readdir(job.dir, { withFileTypes: true });
    } catch {
      errors++;
      return;
    }
    dirsVisited++;
    let git = job.git;
    const dotGit = entries.find((e) => e.name === ".git");
    const isCheckout = !!dotGit && (dotGit.isDirectory() || dotGit.isFile());
    if (dotGit && isCheckout) git = (await gitCtxAt(job.dir, dotGit.isDirectory())) ?? git;
    // 레포 체크아웃: `.claude`·`.agents` 만(플러그인 원본 레포·~/.claude/plugins 안은 예외)
    const repoOnly = isCheckout && !underPlugins(job.dir) && !entries.some((e) => e.name === ".claude-plugin");
    const atHomeClaude = job.dir === homeClaude;
    // `skills/` 바로 아래는 스킬 폴더 — `build`·`out` 같은 이름의 스킬도 있으니 이름 제외를 적용하지 않는다
    const inSkills = basename(job.dir) === "skills";

    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (e.isFile() && e.name === "SKILL.md") {
        // 동시 러너가 있으니 기록 전에 자리부터 잡는다
        if (reserved >= maxCopies) {
          truncatedReason ??= "max_copies";
          continue;
        }
        reserved++;
        await recordSkill(join(job.dir, e.name), job, git);
      } else if (e.isDirectory() && job.depth < cfg.maxDepth && (inSkills || !SKIP_DIRS.has(e.name))) {
        if (repoOnly && !REPO_DESCEND.has(e.name)) continue;
        if (atHomeClaude && HOME_CLAUDE_SKIP.has(e.name)) continue;
        const child = join(job.dir, e.name);
        if (SKIP_SUFFIXES.some((s) => child.endsWith(s))) continue;
        queue.push({ dir: child, depth: job.depth + 1, git, root: job.root });
      }
    }
  };

  // 너비 우선 + 고정 동시성. 한도에 닿으면 남은 큐를 버리고 truncated 로 알린다.
  let active = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    for (;;) {
      if (truncatedReason) return;
      if (now() - started > budget) {
        if (queue.length) truncatedReason ??= "time_budget";
        return;
      }
      if (dirsVisited >= maxDirs && queue.length) {
        truncatedReason ??= "max_dirs";
        return;
      }
      const job = queue.shift();
      if (!job) {
        // 다른 러너가 아직 큐를 채우는 중일 수 있다 — 잠깐 양보 후 재확인
        if (active === 0) return;
        await new Promise((r) => setTimeout(r, 1));
        continue;
      }
      active++;
      try {
        await work(job);
      } finally {
        active--;
      }
    }
  });
  await Promise.all(runners);

  copies.sort((a, b) => a.path.localeCompare(b.path));
  return {
    copies,
    truncated: truncatedReason !== null,
    truncatedReason,
    dirsVisited,
    errors,
    durationMs: now() - started,
    roots,
    maxDepth: cfg.maxDepth,
  };
}
