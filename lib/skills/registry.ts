/* =====================================================================
   스킬 레지스트리 — 사본 묶기·기준본·낡은 사본 판정 + 5분 캐시 + 사본 간 diff.

   묶음 키 = 스킬 이름 + 범위. 레포 스킬은 레포마다 다른 스킬이다(반장의
   writing-plans 와 teamspace 의 writing-plans 는 내용이 달라도 정상).
     레포/워크트리  repo:<메인 레포 폴더 이름>
     전역           global
     플러그인       plugin:<마켓>/<플러그인>[/<변형 경로>] (설치 버전 폴더는 빼서 버전끼리 묶음)
     기타           other
   기준본: 메인 체크아웃(repo) 사본 — 여럿이면 `.claude/skills` 아래 것, 그다음 최근 것.
           메인 사본이 없으면 가장 최근 사본.
   상태: canonical | same(내용 같음) | differs_newer(다르고 기준본보다 새것)
         | stale(다르고 기준본보다 오래됨 = 낡은 사본)

   묶기·diff 는 순수 함수(테스트: registry.test.ts). 스캔 결과는 DB 에 저장하지 않는다.
   ===================================================================== */

import { readFile } from "node:fs/promises";
import { sep } from "node:path";
import { diffLines } from "@/lib/merge3";
import { displayPath, scanSkills, skillScanConfig, MAX_SKILL_BYTES, type ScanResult, type SkillCopy, type SkillScanConfig } from "./scan";

export const CACHE_TTL_MS = 5 * 60 * 1000;
/** 한도에 걸려 잘린 결과는 짧게만 — 부하가 지나가면 곧 다시 훑게. 잘렸는데 0개면 아예 캐시하지 않는다. */
export const TRUNCATED_CACHE_TTL_MS = 30 * 1000;

/** 스캔 결과의 캐시 수명(ms). 0 = 캐시하지 않음. */
export function cacheTtlFor(scan: { truncated: boolean; copies: number }): number {
  if (!scan.truncated) return CACHE_TTL_MS;
  return scan.copies === 0 ? 0 : TRUNCATED_CACHE_TTL_MS;
}
export const DIFF_MAX_LINES = 400;
const DIFF_MAX_CELLS = 16_000_000;

export type CopyStatus = "canonical" | "same" | "differs_newer" | "stale";
export type RegistryCopy = Omit<SkillCopy, "path" | "checkout" | "root"> & { path: string; checkout: string | null; status: CopyStatus };
export type SkillGroup = {
  key: string;
  name: string;
  scope: string;
  canonicalId: string;
  copies: RegistryCopy[];
  distinct: number;
  stale: number;
  differs: number;
};
export type RegistrySummary = { groups: number; copies: number; staleCopies: number; groupsWithStale: number; differingCopies: number; distinctContents: number };

const isCanonicalDir = (p: string) => p.includes(`${sep}.claude${sep}skills${sep}`);
const t = (iso: string) => Date.parse(iso) || 0;

export function pickCanonical(copies: SkillCopy[]): SkillCopy {
  const main = copies.filter((c) => c.kind === "repo");
  const pool = main.length ? main : copies;
  return [...pool].sort((a, b) => {
    if (main.length) {
      const d = Number(isCanonicalDir(b.path)) - Number(isCanonicalDir(a.path));
      if (d) return d;
    }
    return t(b.mtime) - t(a.mtime) || a.path.localeCompare(b.path);
  })[0];
}

export function copyStatus(c: SkillCopy, canon: SkillCopy): CopyStatus {
  if (c.id === canon.id) return "canonical";
  if (c.sha256 === canon.sha256) return "same";
  return t(c.mtime) > t(canon.mtime) ? "differs_newer" : "stale";
}

const STATUS_ORDER: Record<CopyStatus, number> = { canonical: 0, stale: 1, differs_newer: 2, same: 3 };

/** 경로는 표시용(~ 단축)으로 바꿔 내보낸다. 원 경로는 서버에만 남는다. */
export function groupCopies(copies: SkillCopy[], home: string): { groups: SkillGroup[]; summary: RegistrySummary } {
  const byKey = new Map<string, SkillCopy[]>();
  for (const c of copies) {
    const key = `${c.name}@${c.scope}`;
    const arr = byKey.get(key);
    if (arr) arr.push(c);
    else byKey.set(key, [c]);
  }
  const groups: SkillGroup[] = [];
  for (const [key, list] of byKey) {
    const canon = pickCanonical(list);
    const out: RegistryCopy[] = list.map((c) => ({
      id: c.id,
      path: displayPath(c.path, home),
      name: c.name,
      description: c.description,
      sha256: c.sha256,
      lines: c.lines,
      bytes: c.bytes,
      mtime: c.mtime,
      kind: c.kind,
      scope: c.scope,
      repo: c.repo,
      branch: c.branch,
      checkout: c.checkout ? displayPath(c.checkout, home) : null,
      status: copyStatus(c, canon),
    }));
    out.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || t(a.mtime) - t(b.mtime) || a.path.localeCompare(b.path));
    groups.push({
      key,
      name: canon.name,
      scope: canon.scope,
      canonicalId: canon.id,
      copies: out,
      distinct: new Set(list.map((c) => c.sha256)).size,
      stale: out.filter((c) => c.status === "stale").length,
      differs: out.filter((c) => c.status === "stale" || c.status === "differs_newer").length,
    });
  }
  // 낡은 사본이 있는 묶음 먼저, 그다음 다른 내용이 있는 묶음, 이름순
  groups.sort((a, b) => b.stale - a.stale || b.differs - a.differs || a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
  const summary: RegistrySummary = {
    groups: groups.length,
    copies: copies.length,
    staleCopies: groups.reduce((s, g) => s + g.stale, 0),
    groupsWithStale: groups.filter((g) => g.stale > 0).length,
    differingCopies: groups.reduce((s, g) => s + g.differs, 0),
    distinctContents: groups.reduce((s, g) => s + g.distinct, 0),
  };
  return { groups, summary };
}

export function filterGroups(groups: SkillGroup[], opts: { stale?: boolean; name?: string | null }): SkillGroup[] {
  const q = (opts.name ?? "").trim().toLowerCase();
  return groups.filter((g) => (!opts.stale || g.stale > 0) && (!q || g.name.toLowerCase().includes(q)));
}

/* ── diff (순수) ─────────────────────────────────────────────────────── */

export type UnifiedDiff = { lines: string[]; added: number; removed: number; truncated: boolean; identical: boolean };

type Op = { t: " " | "-" | "+"; s: string; ai: number; bi: number };

/** 줄 단위 unified diff(앞뒤 문맥 context 줄). 훅 계산은 merge3 의 LCS 를 재사용한다. */
export function unifiedDiff(aText: string, bText: string, opts: { context?: number; maxLines?: number; aLabel?: string; bLabel?: string } = {}): UnifiedDiff {
  const ctx = opts.context ?? 3;
  const max = opts.maxLines ?? DIFF_MAX_LINES;
  const split = (s: string) => {
    const n = s.replace(/\r\n?/g, "\n");
    return n === "" ? [] : n.replace(/\n$/, "").split("\n");
  };
  const a = split(aText);
  const b = split(bText);
  // LCS 표는 O(n·m) — SKILL.md 규모(수백~수천 줄)에선 충분하지만 이상하게 큰 파일은 막는다
  if (a.length * b.length > DIFF_MAX_CELLS) return { lines: [], added: 0, removed: 0, truncated: true, identical: aText === bText };
  const hunks = diffLines(a, b);
  if (hunks.length === 0) return { lines: [], added: 0, removed: 0, truncated: false, identical: true };

  // 훅 → 줄 연산 열
  const ops: Op[] = [];
  let ai = 0;
  let bi = 0;
  for (const h of hunks) {
    while (ai < h.start) ops.push({ t: " ", s: a[ai], ai: ai++, bi: bi++ });
    for (let k = h.start; k < h.end; k++) ops.push({ t: "-", s: a[k], ai: ai++, bi });
    for (const s of h.lines) ops.push({ t: "+", s, ai, bi: bi++ });
  }
  while (ai < a.length) ops.push({ t: " ", s: a[ai], ai: ai++, bi: bi++ });

  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.t === "+") added++;
    else if (o.t === "-") removed++;
  }

  // 변경 주변 문맥만 남겨 훅으로 묶는다
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.t === " ") return;
    for (let k = Math.max(0, i - ctx); k <= Math.min(ops.length - 1, i + ctx); k++) keep[k] = true;
  });
  const out: string[] = [`--- ${opts.aLabel ?? "a"}`, `+++ ${opts.bLabel ?? "b"}`];
  let i = 0;
  while (i < ops.length) {
    if (!keep[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < ops.length && keep[j]) j++;
    const seg = ops.slice(i, j);
    const aCount = seg.filter((o) => o.t !== "+").length;
    const bCount = seg.filter((o) => o.t !== "-").length;
    const aStart = aCount ? seg.find((o) => o.t !== "+")!.ai + 1 : seg[0].ai;
    const bStart = bCount ? seg.find((o) => o.t !== "-")!.bi + 1 : seg[0].bi;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const o of seg) out.push(`${o.t}${o.s}`);
    i = j;
  }
  const truncated = out.length > max;
  return { lines: truncated ? out.slice(0, max) : out, added, removed, truncated, identical: false };
}

/* ── 캐시·입출력 ─────────────────────────────────────────────────────── */

export type Registry = {
  configured: true;
  scannedAt: string;
  scan: Omit<ScanResult, "copies" | "roots"> & { roots: { path: string; exists: boolean }[] };
  summary: RegistrySummary;
  groups: SkillGroup[];
};

type CacheEntry = { key: string; at: number; ttl: number; registry: Registry; byId: Map<string, SkillCopy> };
let cache: CacheEntry | null = null;
let inflight: { key: string; p: Promise<CacheEntry> } | null = null;

const cfgKey = (c: SkillScanConfig) => `${c.roots.join(":")}|${c.maxDepth}|${c.home}|${c.timeBudgetMs ?? ""}`;

async function build(cfg: SkillScanConfig, scanner: typeof scanSkills): Promise<CacheEntry> {
  const scan = await scanner(cfg);
  const { groups, summary } = groupCopies(scan.copies, cfg.home);
  const { copies, roots, ...rest } = scan;
  return {
    key: cfgKey(cfg),
    at: Date.now(),
    ttl: cacheTtlFor({ truncated: scan.truncated, copies: copies.length }),
    byId: new Map(copies.map((c) => [c.id, c])),
    registry: {
      configured: true,
      scannedAt: new Date().toISOString(),
      scan: { ...rest, roots: roots.map((r) => ({ path: displayPath(r.path, cfg.home), exists: r.exists })) },
      summary,
      groups,
    },
  };
}

async function load(
  refresh: boolean,
  env: Record<string, string | undefined> = process.env,
  scanner: typeof scanSkills = scanSkills,
): Promise<CacheEntry | null> {
  const cfg = skillScanConfig(env);
  if (!cfg) return null;
  const key = cfgKey(cfg);
  if (!refresh && cache && cache.key === key && Date.now() - cache.at < cache.ttl) return cache;
  if (inflight && inflight.key === key) return inflight.p;
  const p = build(cfg, scanner);
  inflight = { key, p };
  try {
    const entry = await p;
    // 잘린 0개 결과는 캐시하지 않는다(다음 요청이 다시 훑는다). 이전 캐시도 버린다 — 다른 설정이거나 이미 낡았다.
    cache = entry.ttl > 0 ? entry : null;
    return entry;
  } finally {
    if (inflight?.p === p) inflight = null;
  }
}

export async function getRegistry(
  opts: { refresh?: boolean; env?: Record<string, string | undefined>; scanner?: typeof scanSkills } = {},
): Promise<Registry | { configured: false }> {
  const entry = await load(!!opts.refresh, opts.env, opts.scanner);
  return entry ? entry.registry : { configured: false };
}

export type CopyMeta = Pick<RegistryCopy, "id" | "path" | "name" | "kind" | "scope" | "repo" | "branch" | "mtime" | "lines" | "sha256">;

const meta = (c: SkillCopy, home: string): CopyMeta => ({
  id: c.id, path: displayPath(c.path, home), name: c.name, kind: c.kind, scope: c.scope, repo: c.repo, branch: c.branch, mtime: c.mtime, lines: c.lines, sha256: c.sha256,
});

/**
 * 두 사본의 diff. 최근 스캔에 있는 id 만 받는다(임의 경로 읽기 금지).
 * 결과: not_configured | unknown_id | 성공.
 */
export async function diffCopies(aId: string, bId: string): Promise<
  | { error: "not_configured" | "unknown_id" | "read_failed" }
  | { a: CopyMeta; b: CopyMeta; diff: UnifiedDiff }
> {
  const entry = await load(false);
  if (!entry) return { error: "not_configured" };
  const a = entry.byId.get(aId);
  const b = entry.byId.get(bId);
  if (!a || !b) return { error: "unknown_id" };
  const home = skillScanConfig()?.home ?? "";
  let at: string;
  let bt: string;
  try {
    const [ab, bb] = await Promise.all([readFile(a.path), readFile(b.path)]);
    if (ab.length > MAX_SKILL_BYTES || bb.length > MAX_SKILL_BYTES) return { error: "read_failed" };
    at = ab.toString("utf8");
    bt = bb.toString("utf8");
  } catch {
    return { error: "read_failed" };
  }
  const label = (c: SkillCopy) => `${displayPath(c.path, home)}${c.branch ? ` (${c.branch})` : ""}`;
  return { a: meta(a, home), b: meta(b, home), diff: unifiedDiff(at, bt, { aLabel: label(a), bLabel: label(b) }) };
}

/** 테스트용 */
export function _resetRegistryCache() {
  cache = null;
  inflight = null;
}
