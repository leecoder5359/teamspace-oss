/**
 * ws env — env 금고 CLI 본체(scripts/ws.ts 가 명령으로 등록한다).
 *
 * 규칙: **값은 어떤 경우에도 stdout/stderr 에 쓰지 않는다.** 출력은 키 이름·개수·경로뿐.
 * (wsEnv.test.ts 가 pull·import 출력에 값이 없음을 고정한다.)
 *
 * - ls      : 키 목록(값 없음)
 * - import  : .env 파일 또는 ssm:/prefix → 기본 드라이런(키 이름 diff). --apply 면 서버에
 *             대기 작업 + 고위험 승인을 만들고, 사람이 Slack 버튼/웹에서 승인할 때까지 폴링 후 적용.
 * - pull    : 파일로만 기록(0600). 기존 파일이 있으면 키 이름 diff 만 보이고 --force 요구.
 * - target  : push 대상(.env 파일·SSM·Vercel·GHA) 추가·목록·삭제.
 * - push    : 계정 확인 → 키 이름 드라이런 → --apply 면 고위험 승인 요청 → 사람이 승인하면 값을 1회 받아
 *             대상에 반영(값은 stdin·0600 임시 파일로만, 프로세스 인자·화면 금지) → 결과(키 이름만) 기록.
 * - drift   : 계정 확인 → (값을 읽을 수 있는 대상만) 금고 값을 메모리로 받아 원격과 비교 → 키별 상태만 서버에 기록.
 * - groups  : syncGroup 일관성(값이 같아야 하는 키 묶음) — 서버가 지문으로 비교, 이름만 출력.
 */

import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { createInterface } from "node:readline";
import { importDiff, ENV_KEY_RE, type ImportMode } from "../lib/envVault/diff";
import {
  compareNames, compareValues, DRIFT_LABEL, DRIFT_STATUSES, groupDrift, isValueReadable, type DriftResults, type DriftStatus,
} from "../lib/envVault/drift";
import { accountSection, buildAccountLines } from "../lib/envVault/sessionAccounts";
import { keyNameDiff, mergeDotenv, parseDotenv, serializeDotenv, type EnvPair } from "../lib/envVault/dotenv";
import {
  isProdTarget, KIND_LABEL, TARGET_KINDS,
  type DotenvConfig, type GhaConfig, type SsmConfig, type TargetKind, type VercelConfig,
} from "../lib/envVault/targets";

export type ApiFn = (method: string, path: string, body?: unknown) => Promise<unknown>;
export type EnvDeps = {
  api: ApiFn;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  exec?: ExecFn;
  /** 대화형 터미널인가(운영 대상 push 의 'yes' 확인용) */
  isTTY?: () => boolean;
  prompt?: (question: string) => Promise<string>;
};

/** 외부 명령 실행 — 셸 없이 인자 배열로. 값은 **input(stdin)** 으로만 넘긴다(인자 금지). */
export type ExecOpts = { input?: string; env?: NodeJS.ProcessEnv; cwd?: string };
export type ExecFn = (file: string, args: string[], opts?: ExecOpts) => Promise<string>;

export const defaultExec: ExecFn = (file, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: opts.env ?? process.env, cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (out += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(Object.assign(new Error(`${file} 종료 코드 ${code}`), { stderr: err }));
    });
    child.stdin.on("error", () => {}); // 명령이 stdin 을 안 읽고 끝나면 EPIPE — 무시
    child.stdin.end(opts.input ?? "");
  });

// ── 프로젝트 참조(이름·short·id) ──────────────────────────────────────────
export async function resolveProject(api: ApiFn, ref: string | undefined): Promise<{ id: string; name: string }> {
  if (!ref) throw new Error("프로젝트(이름 또는 id)가 필요합니다.");
  const r = (await api("GET", "/api/projects")) as { projects: { id: string; name: string; short?: string | null }[] };
  const list = r.projects ?? [];
  const byId = list.find((p) => p.id === ref);
  if (byId) return byId;
  const lower = ref.toLowerCase();
  const hits = list.filter((p) => p.name === ref || p.name.toLowerCase() === lower || (p.short ?? "").toLowerCase() === lower);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`'${ref}' 에 맞는 프로젝트가 여러 개입니다: ${hits.map((p) => `${p.name}(${p.id})`).join(", ")} — id 로 지정하세요.`);
  throw new Error(`프로젝트 '${ref}' 를 찾을 수 없습니다(pnpm ws project ls).`);
}

type VarRow = {
  id: string; env: string; key: string; version: number; valueLength: number; syncGroup: string | null; updatedAt: string; updatedByName: string | null;
  sync?: Record<string, string>;
  drift?: Record<string, string>;
};
const SYNC_LABEL: Record<string, string> = { match: "일치", differs: "다름", never: "미반영" };

export async function envLs(d: EnvDeps, projectRef: string | undefined, env?: string): Promise<void> {
  const p = await resolveProject(d.api, projectRef);
  const qs = new URLSearchParams({ projectId: p.id, ...(env ? { env } : {}) });
  const r = (await d.api("GET", `/api/env?${qs}`)) as { vars: VarRow[]; envs: string[]; targets?: { id: string; kind: string }[] };
  const kindOf = new Map((r.targets ?? []).map((t) => [t.id, t.kind]));
  if (r.vars.length === 0) {
    d.log(`(키 없음) ${p.name}${env ? `/${env}` : ""} · env: ${r.envs.join(", ") || "-"}`);
    return;
  }
  for (const v of r.vars) {
    const sync = Object.entries(v.sync ?? {})
      .map(([id, st]) => {
        const dr = v.drift?.[id];
        return `${kindOf.get(id) ?? id}:${SYNC_LABEL[st] ?? st}${dr ? `/원격 ${DRIFT_LABEL[dr as DriftStatus] ?? dr}` : ""}`;
      })
      .join(",");
    d.log([v.env, v.key, `v${v.version}`, `${v.valueLength}자`, v.syncGroup ?? "-", v.updatedByName ?? "-", v.updatedAt, ...(sync ? [sync] : [])].join("\t"));
  }
  // syncGroup 불일치 경고(이 프로젝트 키가 걸린 묶음만). 조회 실패는 목록을 막지 않는다.
  try {
    const groups = await fetchSyncGroups(d.api);
    const bad = groups.filter((g) => !g.consistent && g.members.some((m) => m.projectId === p.id));
    for (const g of bad) d.log(`⚠ syncGroup '${g.name}' 값 불일치: ${g.members.map(memberLabel).join(", ")}`);
  } catch {
    /* 무시 */
  }
}

// ── syncGroup (P3b) ──────────────────────────────────────────────────────
type SyncGroupMember = { projectId: string; projectName: string; env: string; key: string; varId: string };
export type SyncGroupInfo = { name: string; members: SyncGroupMember[]; consistent: boolean };
const memberLabel = (m: SyncGroupMember) => `${m.projectName}/${m.env}/${m.key}`;

async function fetchSyncGroups(api: ApiFn): Promise<SyncGroupInfo[]> {
  return ((await api("GET", "/api/env/sync-groups")) as { syncGroups: SyncGroupInfo[] }).syncGroups ?? [];
}

export async function envGroups(d: EnvDeps): Promise<void> {
  const groups = await fetchSyncGroups(d.api);
  if (groups.length === 0) {
    d.log("(syncGroup 없음) 키 편집에서 syncGroup 을 지정하면 같은 이름끼리 값이 같은지 확인합니다.");
    return;
  }
  for (const g of groups) {
    d.log(`${g.consistent ? "일치" : "⚠ 불일치"}\t${g.name}\t${g.members.length}개\t${g.members.map(memberLabel).join(", ")}`);
  }
  const bad = groups.filter((g) => !g.consistent).length;
  d.log(bad ? `값이 서로 다른 syncGroup ${bad}개 — 웹(설정 → env 금고)에서 값을 맞추세요.` : "모든 syncGroup 의 값이 같습니다.");
}

// ── 가져오기 원본 ─────────────────────────────────────────────────────────
export type ImportSource = { kind: "dotenv"; path: string } | { kind: "ssm"; prefix: string; profile?: string; region?: string };

export function parseSource(from: string | undefined, profile?: string, region?: string): ImportSource {
  if (!from) throw new Error("--from <.env 경로 | ssm:/prefix> 가 필요합니다.");
  if (from.startsWith("ssm:")) {
    const prefix = from.slice(4);
    if (!prefix.startsWith("/")) throw new Error("ssm 경로는 / 로 시작해야 합니다(예: ssm:/myapp/dev).");
    return { kind: "ssm", prefix, profile, region };
  }
  return { kind: "dotenv", path: from };
}

/** SSM 파라미터 → 키=경로 마지막 조각. 셸 없이 execFile 로 aws CLI 호출. */
export async function readSsm(
  src: Extract<ImportSource, { kind: "ssm" }>,
  exec = defaultExec,
  opts: { recursive?: boolean } = {},
): Promise<{ vars: EnvPair[]; skipped: string[] }> {
  const args = ["ssm", "get-parameters-by-path", "--path", src.prefix, ...(opts.recursive === false ? [] : ["--recursive"]), "--with-decryption", "--output", "json"];
  if (src.profile) args.push("--profile", src.profile);
  if (src.region) args.push("--region", src.region);
  let stdout: string;
  try {
    stdout = await exec("aws", args);
  } catch (e) {
    // aws 의 에러 출력에는 값이 없지만, 혹시 몰라 첫 줄만 보인다
    const msg = e instanceof Error ? (e as Error & { stderr?: string }).stderr?.split("\n")[0] || e.message.split("\n")[0] : "";
    throw new Error(`aws ssm 조회 실패: ${msg}`);
  }
  const data = JSON.parse(stdout) as { Parameters?: { Name: string; Value: string }[] };
  const vars: EnvPair[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const p of data.Parameters ?? []) {
    const key = p.Name.split("/").filter(Boolean).pop() ?? "";
    if (!ENV_KEY_RE.test(key) || seen.has(key)) {
      skipped.push(p.Name);
      continue;
    }
    seen.add(key);
    vars.push({ key, value: p.Value });
  }
  return { vars, skipped };
}

function readSource(src: ImportSource, exec?: EnvDeps["exec"]): Promise<{ vars: EnvPair[]; skipped: string[] }> {
  if (src.kind === "ssm") return readSsm(src, exec);
  const all = parseDotenv(readFileSync(src.path, "utf8"));
  const vars = all.filter((v) => ENV_KEY_RE.test(v.key));
  return Promise.resolve({ vars, skipped: all.filter((v) => !ENV_KEY_RE.test(v.key)).map((v) => v.key) });
}

export const POLL_MS = 5000;
export const POLL_LIMIT_MS = 30 * 60 * 1000;

/** 사람이 승인할 때까지 폴링(5초 간격). 거부·추가요청·시간 초과면 throw. */
export async function waitForApproval(d: EnvDeps, approvalId: string, limitMs: number): Promise<void> {
  const sleep = d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = d.now ?? Date.now;
  const deadline = now() + limitMs;
  for (;;) {
    const r = (await d.api("GET", `/api/approvals/${approvalId}`)) as { approval: { status: string; responseText?: string | null } };
    const st = r.approval.status;
    if (st === "approved") return;
    if (st === "rejected" || st === "additional") {
      throw new Error(`승인되지 않았습니다(${st})${r.approval.responseText ? `: ${r.approval.responseText}` : ""}. 반영하지 않았습니다.`);
    }
    if (now() >= deadline) throw new Error(`${Math.round(limitMs / 60000)}분 안에 승인되지 않아 중단합니다. 반영하지 않았습니다.`);
    await sleep(POLL_MS);
  }
}

export async function envImport(
  d: EnvDeps,
  a: { project?: string; env?: string; from?: string; profile?: string; region?: string; overwrite: boolean; apply: boolean; channel?: string },
): Promise<void> {
  if (!a.env) throw new Error("env 가 필요합니다: ws env import <project> <env> --from ...");
  const p = await resolveProject(d.api, a.project);
  const src = parseSource(a.from, a.profile, a.region);
  const { vars, skipped } = await readSource(src, d.exec);
  if (skipped.length) d.log(`건너뜀(키 이름 형식 ^[A-Z_][A-Z0-9_]*$ 아님·중복) ${skipped.length}개: ${skipped.join(", ")}`);
  if (vars.length === 0) throw new Error("가져올 키가 없습니다.");
  const empty = vars.filter((v) => v.value === "").map((v) => v.key);
  if (empty.length) throw new Error(`값이 비어 있는 키가 있습니다: ${empty.join(", ")} — 값을 채우거나 빼고 다시 시도하세요(서버도 거부합니다).`);
  const mode: ImportMode = a.overwrite ? "overwrite" : "merge";
  const cur = (await d.api("GET", `/api/env?${new URLSearchParams({ projectId: p.id, env: a.env })}`)) as { vars: { key: string }[] };
  const diff = importDiff(vars.map((v) => v.key), cur.vars.map((v) => v.key), mode);
  d.log(`대상 ${p.name}/${a.env} · 원본 ${src.kind === "ssm" ? `ssm:${src.prefix}` : src.path} · 모드 ${mode}`);
  d.log(`  추가 ${diff.added.length}: ${diff.added.join(", ") || "-"}`);
  d.log(`  변경 ${diff.changed.length}: ${diff.changed.join(", ") || "-"}`);
  d.log(`  건너뜀(이미 있음) ${diff.skipped.length}: ${diff.skipped.join(", ") || "-"}`);
  if (!a.apply) {
    d.log("드라이런입니다. 반영하려면 --apply (사람의 고위험 승인 필요)");
    return;
  }
  if (diff.added.length + diff.changed.length === 0) {
    d.log("반영할 키가 없습니다.");
    return;
  }

  const req = (await d.api("POST", "/api/env/import", { projectId: p.id, env: a.env, vars, mode, channel: a.channel })) as {
    opId: string; approvalId: string; sent: boolean; error?: string;
  };
  d.log(`승인 요청 ${req.approvalId} 생성${req.sent ? " · 슬랙 발송됨" : ` · 슬랙 미발송(${req.error ?? "unknown"}) — 웹 /approvals 에서 승인`}`);
  d.log("사람이 승인할 때까지 기다립니다(5초 간격, 최대 30분)…");

  await waitForApproval(d, req.approvalId, POLL_LIMIT_MS);
  const res = (await d.api("POST", `/api/env/import/${req.opId}/apply`)) as { applied: { added: string[]; changed: string[] } };
  d.log(`반영 완료: 추가 ${res.applied.added.length} · 변경 ${res.applied.changed.length}`);
}

export async function envPull(
  d: EnvDeps,
  a: { project?: string; env?: string; out?: string; force: boolean },
): Promise<void> {
  if (!a.env) throw new Error("env 가 필요합니다: ws env pull <project> <env> --out <path>");
  if (!a.out) throw new Error("--out <path> 가 필요합니다(값은 화면에 출력하지 않고 파일로만 씁니다).");
  const p = await resolveProject(d.api, a.project);
  const r = (await d.api("POST", "/api/env/pull", { projectId: p.id, env: a.env })) as { vars: EnvPair[] };
  if (existsSync(a.out)) {
    let current: string[] = [];
    try {
      current = parseDotenv(readFileSync(a.out, "utf8")).map((v) => v.key);
    } catch {
      current = [];
    }
    const diff = keyNameDiff(current, r.vars.map((v) => v.key));
    d.log(`${a.out} 가 이미 있습니다 — 키 이름 비교:`);
    d.log(`  새로 생김 ${diff.added.length}: ${diff.added.join(", ") || "-"}`);
    d.log(`  사라짐 ${diff.removed.length}: ${diff.removed.join(", ") || "-"}`);
    d.log(`  유지(값은 금고 기준으로 덮어씀) ${diff.kept.length}`);
    if (!a.force) {
      d.log("덮어쓰려면 --force 를 붙이세요.");
      return;
    }
  }
  const header = `TeamSpace env 금고 — ${p.name}/${a.env} (${new Date().toISOString()})\n이 파일을 커밋하거나 출력하지 마세요.`;
  writeFileSync(a.out, serializeDotenv(r.vars, header), { mode: 0o600 });
  chmodSync(a.out, 0o600); // 기존 파일이면 writeFileSync 의 mode 가 적용되지 않는다
  d.log(`${r.vars.length}개 키를 ${a.out} 에 기록했습니다(0600).`);
}

// ══ P2: push 대상·push ═══════════════════════════════════════════════════

export type TargetInfo = {
  id: string;
  projectId: string;
  env: string;
  kind: TargetKind;
  config: Record<string, string | undefined>;
  account: Record<string, string | undefined>;
  summary: string;
  accountSummary: string;
  lastPushedAt: string | null;
};

export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** gh 는 GITHUB_TOKEN/GH_TOKEN 이 있으면 그 토큰(회사 계정일 수 있다)을 우선한다 — 지워서 본인 로그인으로 돌린다. */
export function ghEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const e = { ...base };
  for (const k of ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_ENTERPRISE_TOKEN"]) delete e[k];
  return e;
}

/** 외부 명령 에러 → 한 줄. 혹시 값이 섞여 있으면 *** 로 가린다. */
export function errLine(e: unknown, secrets: string[] = []): string {
  const raw = e instanceof Error ? (e as Error & { stderr?: string }).stderr?.trim() || e.message : String(e);
  let line = raw.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "실패";
  for (const s of secrets) if (s.length >= 4) line = line.split(s).join("***");
  return line.slice(0, 200);
}

// ── 대상 추가·목록·삭제 ────────────────────────────────────────────────────
export type TargetAddArgs = {
  project?: string;
  env?: string;
  kind?: string;
  account?: string;
  path?: string;
  prefix?: string;
  region?: string;
  profile?: string;
  vercelProject?: string;
  scope?: string;
  target?: string;
  globalDir?: string;
  repo?: string;
  ghEnv?: string;
};

/** CLI 플래그 → {config, account}. 상대 경로는 지금 위치 기준 절대 경로로 바꾼다(~ 는 그대로). */
export function buildTargetSpec(a: TargetAddArgs): { kind: TargetKind; config: Record<string, string>; account: Record<string, string> } {
  if (!a.kind || !(TARGET_KINDS as readonly string[]).includes(a.kind)) throw new Error(`--kind ${TARGET_KINDS.join("|")} 가 필요합니다.`);
  const kind = a.kind as TargetKind;
  const abs = (p: string) => (p.startsWith("~") ? p : resolvePath(p));
  const clean = (o: Record<string, string | undefined>) => Object.fromEntries(Object.entries(o).filter((e): e is [string, string] => !!e[1]));
  const need = (v: string | undefined, flag: string) => {
    if (!v) throw new Error(`${KIND_LABEL[kind]} 대상에는 ${flag} 가 필요합니다.`);
    return v;
  };
  switch (kind) {
    case "dotenv":
      return { kind, config: { path: abs(need(a.path, "--path <파일>")) }, account: {} };
    case "ssm":
      return {
        kind,
        config: clean({ prefix: need(a.prefix, "--prefix </경로>"), region: a.region, profile: a.profile }),
        account: { accountId: need(a.account, "--account <AWS 계정 id 12자리>") },
      };
    case "vercel":
      return {
        kind,
        config: clean({
          project: need(a.vercelProject, "--vercel-project <이름>"), target: need(a.target, "--target development|preview|production"),
          scope: a.scope, globalDir: a.globalDir ? abs(a.globalDir) : undefined,
        }),
        account: { user: need(a.account, "--account <vercel whoami 사용자>") },
      };
    case "gha":
      return {
        kind,
        config: clean({ repo: need(a.repo, "--repo <owner/repo>"), environment: a.ghEnv }),
        account: { login: need(a.account, "--account <GitHub 로그인>") },
      };
  }
}

export async function envTargetAdd(d: EnvDeps, a: TargetAddArgs): Promise<void> {
  if (!a.env) throw new Error("env 가 필요합니다: ws env target add <project> <env> --kind ...");
  const spec = buildTargetSpec(a);
  const p = await resolveProject(d.api, a.project);
  const r = (await d.api("POST", "/api/env/targets", { projectId: p.id, env: a.env, ...spec })) as { target: TargetInfo };
  d.log(`대상 추가: ${r.target.id} · ${p.name}/${a.env} · ${KIND_LABEL[spec.kind]} ${r.target.summary} · ${r.target.accountSummary}`);
}

export async function envTargetLs(d: EnvDeps, projectRef: string | undefined, env?: string): Promise<void> {
  const p = await resolveProject(d.api, projectRef);
  const qs = new URLSearchParams({ projectId: p.id, ...(env ? { env } : {}) });
  const r = (await d.api("GET", `/api/env/targets?${qs}`)) as { targets: TargetInfo[] };
  if (r.targets.length === 0) {
    d.log(`(대상 없음) ${p.name}${env ? `/${env}` : ""}`);
    return;
  }
  for (const t of r.targets) {
    d.log([t.id, t.env, t.kind, t.summary, t.accountSummary, t.lastPushedAt ? `마지막 반영 ${t.lastPushedAt}` : "반영 기록 없음"].join("\t"));
  }
  // 세션 컨텍스트(/api/context compact)에 들어갈 계정 줄 — env 필터가 없을 때만(주입은 프로젝트 전체 대상 기준)
  if (!env) {
    const sec = accountSection(buildAccountLines(r.targets, { home: homedir() }));
    if (sec.length) d.log(["", "세션 주입 미리보기:", ...sec.slice(0, -1)].join("\n"));
  }
}

export async function envTargetRm(d: EnvDeps, id: string | undefined): Promise<void> {
  if (!id) throw new Error("대상 id 가 필요합니다: ws env target rm <id> (ws env target ls 로 확인)");
  await d.api("DELETE", `/api/env/targets/${encodeURIComponent(id)}`);
  d.log(`대상 ${id} 를 지웠습니다(원격에 반영된 값은 그대로).`);
}

// ── 계정 확인 ─────────────────────────────────────────────────────────────
const vercelGlobal = (c: VercelConfig) => (c.globalDir ? ["-Q", expandHome(c.globalDir)] : []);
const vercelScope = (c: VercelConfig) => (c.scope ? ["--scope", c.scope] : []);
const awsOpts = (c: SsmConfig) => [...(c.profile ? ["--profile", c.profile] : []), ...(c.region ? ["--region", c.region] : [])];

/** vercel 은 지금 폴더에 링크된 프로젝트를 섞어 쓰지 않게 빈 임시 폴더에서 돌린다. */
function withScratchDir<T>(f: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ws-env-"));
  return f(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** 반영 직전 로컬 로그인 계정이 대상의 기대 계정과 같은지 본다. 다르면 throw(반영 거부). 찾은 계정을 돌려준다. */
export async function checkAccount(t: TargetInfo, exec: ExecFn = defaultExec): Promise<string> {
  const fail = (found: string, want: string) =>
    new Error(`계정이 다릅니다 — 지금 로그인: ${found} · 기대: ${want}. 반영하지 않았습니다(로그인 계정을 바꾸거나 대상의 account 를 고치세요).`);
  switch (t.kind) {
    case "dotenv":
      return "로컬 파일(계정 확인 없음)";
    case "ssm": {
      const c = t.config as SsmConfig;
      const want = t.account.accountId;
      if (!want) throw new Error("대상에 기대 AWS 계정(accountId)이 없습니다.");
      let found: string;
      try {
        found = String((JSON.parse(await exec("aws", ["sts", "get-caller-identity", "--output", "json", ...awsOpts(c)])) as { Account?: string }).Account ?? "");
      } catch (e) {
        throw new Error(`aws 계정 확인 실패: ${errLine(e)}`);
      }
      if (found !== want) throw fail(`AWS ${found || "?"}`, `AWS ${want}`);
      return `AWS ${found}${c.profile ? ` (프로필 ${c.profile})` : ""}`;
    }
    case "vercel": {
      const c = t.config as VercelConfig;
      const want = t.account.user;
      if (!want) throw new Error("대상에 기대 Vercel 사용자(user)가 없습니다.");
      let out: string;
      try {
        out = await withScratchDir((cwd) => exec("vercel", [...vercelGlobal(c), "whoami", "--format", "json", ...vercelScope(c)], { cwd }));
      } catch (e) {
        throw new Error(`vercel 계정 확인 실패: ${errLine(e)}`);
      }
      let found = "";
      try {
        found = String((JSON.parse(out) as { username?: string }).username ?? "");
      } catch {
        found = out.trim().split("\n").pop()?.replace(/^>\s*/, "").trim() ?? "";
      }
      if (found.toLowerCase() !== want.toLowerCase()) throw fail(`Vercel ${found || "?"}`, `Vercel ${want}`);
      return `Vercel ${found}${c.scope ? ` · scope ${c.scope}` : ""}${c.globalDir ? ` · -Q ${c.globalDir}` : ""}`;
    }
    case "gha": {
      const want = t.account.login;
      if (!want) throw new Error("대상에 기대 GitHub 로그인(login)이 없습니다.");
      let found: string;
      try {
        found = (await exec("gh", ["api", "user", "--jq", ".login"], { env: ghEnv() })).trim();
      } catch (e) {
        throw new Error(`gh 계정 확인 실패(GITHUB_TOKEN/GH_TOKEN 은 빼고 확인): ${errLine(e)}`);
      }
      if (found.toLowerCase() !== want.toLowerCase()) throw fail(`GitHub ${found || "?"}`, `GitHub ${want}`);
      return `GitHub ${found} (GITHUB_TOKEN/GH_TOKEN 무시)`;
    }
  }
}

// ── 원격 키 이름 목록(값은 읽지 않는다) ─────────────────────────────────────
/** 대상에 지금 있는 키 이름. 읽지 못하면 null(동기 상태로만 판단). */
export async function remoteKeys(t: TargetInfo, exec: ExecFn = defaultExec): Promise<Set<string> | null> {
  try {
    switch (t.kind) {
      case "dotenv": {
        const path = expandHome((t.config as DotenvConfig).path);
        if (!existsSync(path)) return new Set();
        return new Set(parseDotenv(readFileSync(path, "utf8")).map((v) => v.key));
      }
      case "ssm": {
        const c = t.config as SsmConfig;
        // --with-decryption 없이 이름만(--query) — 값은 받지도 않는다
        const out = await exec("aws", ["ssm", "get-parameters-by-path", "--path", c.prefix, "--query", "Parameters[].Name", "--output", "json", ...awsOpts(c)]);
        const names = (JSON.parse(out) as string[] | null) ?? [];
        return new Set(names.map((n) => n.split("/").filter(Boolean).pop() ?? "").filter((k) => ENV_KEY_RE.test(k)));
      }
      case "vercel": {
        const c = t.config as VercelConfig;
        const out = await withScratchDir((cwd) =>
          exec("vercel", [...vercelGlobal(c), "env", "ls", c.target, "--project", c.project, "--format", "json", ...vercelScope(c)], { cwd }),
        );
        const j = JSON.parse(out) as { envs?: { key?: string }[] } | { key?: string }[];
        const list = Array.isArray(j) ? j : j.envs ?? [];
        return new Set(list.map((e) => e.key ?? "").filter(Boolean));
      }
      case "gha": {
        const c = t.config as GhaConfig;
        const out = await exec("gh", ["secret", "list", "--repo", c.repo, ...(c.environment ? ["--env", c.environment] : []), "--json", "name"], { env: ghEnv() });
        return new Set(((JSON.parse(out) as { name: string }[]) ?? []).map((s) => s.name));
      }
    }
  } catch {
    return null;
  }
}

// ── 어댑터: 값은 stdin 또는 0600 임시 파일로만 넘긴다 ───────────────────────
export type PushOutcome = { pushed: string[]; failed: { key: string; error: string }[] };

export function pushDotenv(c: DotenvConfig, vars: EnvPair[]): PushOutcome {
  const path = expandHome(c.path);
  try {
    const cur = existsSync(path) ? readFileSync(path, "utf8") : "";
    // 같은 폴더 임시 파일(0600)에 쓰고 rename — 중간에 끊겨도 반쯤 쓴 파일이 남지 않게
    const tmp = join(dirname(path), `.${Date.now()}.ws-env.tmp`);
    writeFileSync(tmp, mergeDotenv(cur, vars), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    chmodSync(path, 0o600);
    return { pushed: vars.map((v) => v.key), failed: [] };
  } catch (e) {
    const error = errLine(e, vars.map((v) => v.value));
    return { pushed: [], failed: vars.map((v) => ({ key: v.key, error })) };
  }
}

export async function pushSsm(c: SsmConfig, vars: EnvPair[], exec: ExecFn = defaultExec): Promise<PushOutcome> {
  const out: PushOutcome = { pushed: [], failed: [] };
  const base = c.prefix === "/" ? "" : c.prefix.replace(/\/+$/, "");
  const dir = mkdtempSync(join(tmpdir(), "ws-env-ssm-")); // 0700
  try {
    for (const v of vars) {
      const file = join(dir, v.key);
      try {
        writeFileSync(file, v.value, { mode: 0o600 });
        await exec("aws", ["ssm", "put-parameter", "--name", `${base}/${v.key}`, "--type", "SecureString", "--overwrite", "--value", `file://${file}`, ...awsOpts(c)]);
        out.pushed.push(v.key);
      } catch (e) {
        out.failed.push({ key: v.key, error: errLine(e, [v.value]) });
      } finally {
        rmSync(file, { force: true });
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

/** vercel env add --force(있으면 덮어씀 — rm 후 add 사이에 값이 비는 틈이 없다), 값은 stdin. */
export async function pushVercel(c: VercelConfig, vars: EnvPair[], exec: ExecFn = defaultExec): Promise<PushOutcome> {
  const out: PushOutcome = { pushed: [], failed: [] };
  await withScratchDir(async (cwd) => {
    for (const v of vars) {
      try {
        await exec("vercel", [...vercelGlobal(c), "env", "add", v.key, c.target, "--project", c.project, "--force", "--yes", ...vercelScope(c)], { input: v.value, cwd });
        out.pushed.push(v.key);
      } catch (e) {
        out.failed.push({ key: v.key, error: errLine(e, [v.value]) });
      }
    }
  });
  return out;
}

export async function pushGha(c: GhaConfig, vars: EnvPair[], exec: ExecFn = defaultExec): Promise<PushOutcome> {
  const out: PushOutcome = { pushed: [], failed: [] };
  const env = ghEnv();
  for (const v of vars) {
    try {
      await exec("gh", ["secret", "set", v.key, "--repo", c.repo, ...(c.environment ? ["--env", c.environment] : [])], { input: v.value, env });
      out.pushed.push(v.key);
    } catch (e) {
      out.failed.push({ key: v.key, error: errLine(e, [v.value]) });
    }
  }
  return out;
}

export function applyToTarget(t: TargetInfo, vars: EnvPair[], exec: ExecFn = defaultExec): Promise<PushOutcome> {
  switch (t.kind) {
    case "dotenv":
      return Promise.resolve(pushDotenv(t.config as DotenvConfig, vars));
    case "ssm":
      return pushSsm(t.config as SsmConfig, vars, exec);
    case "vercel":
      return pushVercel(t.config as VercelConfig, vars, exec);
    case "gha":
      return pushGha(t.config as GhaConfig, vars, exec);
  }
}

// ── 드라이런 계획 ─────────────────────────────────────────────────────────
type SyncVar = { key: string; sync?: Record<string, "match" | "differs" | "never"> };
export type PushPlan = { add: string[]; update: string[]; same: string[]; remoteOnly: string[]; remoteKnown: boolean };

/** 키 이름·동기 상태만으로 계획을 세운다(값 비교 없음). remote 가 null 이면 동기 상태로만. */
export function planPush(vault: SyncVar[], selected: string[], targetId: string, remote: Set<string> | null): PushPlan {
  const byKey = new Map(vault.map((v) => [v.key, v.sync?.[targetId] ?? "never"]));
  const plan: PushPlan = { add: [], update: [], same: [], remoteOnly: [], remoteKnown: remote !== null };
  for (const k of [...selected].sort()) {
    const st = byKey.get(k) ?? "never";
    const present = remote ? remote.has(k) : st !== "never";
    if (!present) plan.add.push(k);
    else if (st === "match") plan.same.push(k);
    else plan.update.push(k);
  }
  if (remote) plan.remoteOnly = [...remote].filter((k) => !byKey.has(k)).sort();
  return plan;
}

// ── push ─────────────────────────────────────────────────────────────────
export const PUSH_WAIT_MS = 10 * 60 * 1000;

const defaultIsTTY = () => !!process.stdin.isTTY && !!process.stdout.isTTY;
const defaultPrompt = (q: string) =>
  new Promise<string>((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => {
      rl.close();
      res(a);
    });
  });

async function confirmProd(d: EnvDeps, t: TargetInfo): Promise<void> {
  if (!isProdTarget(t.env, t.kind, t.config)) return;
  if (!(d.isTTY ?? defaultIsTTY)()) {
    throw new Error(`운영 대상(${t.env} · ${t.summary})은 터미널에서 직접 실행해 'yes' 를 입력해야 합니다(비대화형 실행 거부).`);
  }
  const a = await (d.prompt ?? defaultPrompt)(`운영 대상입니다: ${t.env} → ${KIND_LABEL[t.kind]} ${t.summary}. 계속하려면 yes 입력: `);
  if (a.trim() !== "yes") throw new Error("확인하지 않아 중단했습니다.");
}

export type PushArgs = { targetId?: string; keys?: string; apply: boolean; wait: boolean; channel?: string; op?: string };

export async function envPush(d: EnvDeps, a: PushArgs): Promise<void> {
  if (!a.targetId) throw new Error("대상 id 가 필요합니다: ws env push <targetId> (ws env target ls 로 확인)");
  const exec = d.exec ?? defaultExec;
  const tr = (await d.api("GET", `/api/env/targets?${new URLSearchParams({ id: a.targetId })}`)) as { targets: TargetInfo[] };
  const t = tr.targets[0];
  if (!t) throw new Error(`대상 '${a.targetId}' 를 찾을 수 없습니다.`);
  d.log(`대상 ${t.id} · ${t.env} → ${KIND_LABEL[t.kind]} ${t.summary}`);

  // ① 계정 확인 — 다르면 여기서 멈춘다(승인 요청도 만들지 않는다)
  const who = await checkAccount(t, exec);
  d.log(`계정 확인: ${who}`);

  if (a.op) {
    await confirmProd(d, t);
    await claimAndApply(d, t, a.op, exec);
    return;
  }

  // ② 드라이런: 키 이름 diff(값 없음)
  const vr = (await d.api("GET", `/api/env?${new URLSearchParams({ projectId: t.projectId, env: t.env })}`)) as { vars: SyncVar[] };
  const vaultKeys = vr.vars.map((v) => v.key);
  const explicit = a.keys ? [...new Set(a.keys.split(",").map((k) => k.trim()).filter(Boolean))] : null;
  if (explicit) {
    const missing = explicit.filter((k) => !vaultKeys.includes(k));
    if (missing.length) throw new Error(`금고에 없는 키: ${missing.join(", ")}`);
  }
  const remote = await remoteKeys(t, exec);
  const plan = planPush(vr.vars, explicit ?? vaultKeys, t.id, remote);
  if (!plan.remoteKnown) d.log("원격 키 목록을 읽지 못했습니다 — 마지막 반영 기록(지문)으로만 판단합니다.");
  d.log(`  추가 ${plan.add.length}: ${plan.add.join(", ") || "-"}`);
  d.log(`  변경 ${plan.update.length}: ${plan.update.join(", ") || "-"}`);
  d.log(`  동일(마지막 반영과 같음) ${plan.same.length}: ${plan.same.join(", ") || "-"}`);
  if (plan.remoteKnown) d.log(`  원격에만 있음(지우지 않음) ${plan.remoteOnly.length}: ${plan.remoteOnly.join(", ") || "-"}`);
  // --keys 로 고르면 동일한 것도 다시 보낸다. 아니면 추가·변경만.
  const send = explicit ? [...explicit].sort() : [...plan.add, ...plan.update].sort();
  if (!a.apply) {
    d.log(`드라이런입니다. 보낼 키 ${send.length}개. 반영하려면 --apply (사람의 고위험 승인 필요)`);
    return;
  }
  if (send.length === 0) {
    d.log("반영할 키가 없습니다.");
    return;
  }

  // ③ 운영이면 터미널 확인 → 승인 요청
  await confirmProd(d, t);
  const req = (await d.api("POST", `/api/env/targets/${encodeURIComponent(t.id)}/push`, { keys: send, channel: a.channel })) as {
    opId: string; approvalId: string; sent: boolean; error?: string;
  };
  d.log(`승인 요청 ${req.approvalId} 생성${req.sent ? " · 슬랙 발송됨" : ` · 슬랙 미발송(${req.error ?? "unknown"}) — 웹 /approvals 에서 승인`}`);
  if (!a.wait) {
    d.log(`사람이 승인한 뒤 30분 안에 이어서 실행하세요: pnpm ws env push ${t.id} --op ${req.opId}`);
    return;
  }
  d.log("사람이 승인할 때까지 기다립니다(5초 간격, 최대 10분)…");
  await waitForApproval(d, req.approvalId, PUSH_WAIT_MS);
  // ④ 승인 뒤: 값 1회 받기 → 반영 → 결과 기록
  await claimAndApply(d, t, req.opId, exec);
}

async function claimAndApply(d: EnvDeps, t: TargetInfo, opId: string, exec: ExecFn): Promise<void> {
  const c = (await d.api("POST", `/api/env/push/${encodeURIComponent(opId)}/claim`)) as { targetId: string; vars: EnvPair[] };
  let outcome: PushOutcome;
  if (c.targetId !== t.id) {
    // 다른 대상용 작업 — 값은 쓰지 않고 실패로 닫는다
    outcome = { pushed: [], failed: c.vars.map((v) => ({ key: v.key, error: "다른 대상의 작업" })) };
  } else {
    try {
      outcome = await applyToTarget(t, c.vars, exec);
    } catch (e) {
      const error = errLine(e, c.vars.map((v) => v.value));
      outcome = { pushed: [], failed: c.vars.map((v) => ({ key: v.key, error })) };
    }
  }
  const r = (await d.api("POST", `/api/env/push/${encodeURIComponent(opId)}/result`, outcome)) as { status: string };
  d.log(`반영 ${outcome.pushed.length}개 · 실패 ${outcome.failed.length}개 (${r.status})${outcome.pushed.length ? `: ${outcome.pushed.join(", ")}` : ""}`);
  for (const f of outcome.failed) d.log(`  실패 ${f.key}: ${f.error}`);
  if (c.targetId !== t.id) throw new Error("이 작업은 다른 대상용입니다. 반영하지 않았습니다.");
  if (outcome.failed.length) throw new Error(`${outcome.failed.length}개 키를 반영하지 못했습니다.`);
}

// ══ P3a: 드리프트 점검 ════════════════════════════════════════════════════

/**
 * 원격 값 읽기(.env 파일·SSM). 값은 메모리에서 비교에만 쓰고 어디에도 출력·전송하지 않는다.
 * SSM 은 push 가 쓰는 자리(<prefix>/<KEY>)만 본다(--recursive 없음).
 */
export async function readRemoteValues(t: TargetInfo, exec: ExecFn = defaultExec): Promise<EnvPair[]> {
  if (t.kind === "dotenv") {
    const path = expandHome((t.config as DotenvConfig).path);
    if (!existsSync(path)) return [];
    return parseDotenv(readFileSync(path, "utf8"));
  }
  if (t.kind === "ssm") {
    const c = t.config as SsmConfig;
    return (await readSsm({ kind: "ssm", prefix: c.prefix, profile: c.profile, region: c.region }, exec, { recursive: false })).vars;
  }
  throw new Error(`${KIND_LABEL[t.kind]} 는 값을 읽을 수 없습니다(이름만 비교).`);
}

/** 대상 하나 점검 → 키별 상태. 값은 반환하지 않는다. */
export async function driftTarget(
  d: EnvDeps,
  t: TargetInfo,
  exec: ExecFn,
): Promise<{ results: DriftResults; stale: string[]; never: string[] }> {
  // 금고 키 이름 + P2 동기 상태(마지막 반영 이후 금고 값이 바뀌었나)
  const vr = (await d.api("GET", `/api/env?${new URLSearchParams({ projectId: t.projectId, env: t.env })}`)) as {
    vars: { key: string; sync?: Record<string, string> }[];
  };
  const stale = vr.vars.filter((v) => v.sync?.[t.id] === "differs").map((v) => v.key);
  const never = vr.vars.filter((v) => (v.sync?.[t.id] ?? "never") === "never").map((v) => v.key);
  if (isValueReadable(t.kind)) {
    // 값 비교: 금고 값을 메모리로 받는다(pull 과 같은 경로, 감사는 drift_read 1행). 파일·화면에는 쓰지 않는다.
    const pr = (await d.api("POST", "/api/env/pull", { projectId: t.projectId, env: t.env, purpose: "drift" })) as { vars: EnvPair[] };
    let remote: EnvPair[];
    try {
      remote = await readRemoteValues(t, exec);
    } catch (e) {
      throw new Error(`원격 값을 읽지 못했습니다: ${errLine(e, pr.vars.map((v) => v.value))}`);
    }
    return { results: compareValues(pr.vars, remote), stale, never };
  }
  const names = await remoteKeys(t, exec);
  if (!names) throw new Error("원격 키 목록을 읽지 못했습니다(로그인·권한 확인).");
  return { results: compareNames(vr.vars.map((v) => v.key), names), stale, never };
}

export type DriftArgs = { targetId?: string; all: boolean; project?: string; env?: string };

export async function envDrift(d: EnvDeps, a: DriftArgs): Promise<void> {
  const exec = d.exec ?? defaultExec;
  let targets: TargetInfo[];
  if (a.all) {
    const qs = new URLSearchParams();
    if (a.project) qs.set("projectId", (await resolveProject(d.api, a.project)).id);
    if (a.env) qs.set("env", a.env);
    targets = ((await d.api("GET", `/api/env/targets?${qs}`)) as { targets: TargetInfo[] }).targets;
    if (targets.length === 0) {
      d.log("(점검할 대상 없음)");
      return;
    }
  } else {
    if (!a.targetId) throw new Error("대상 id 또는 --all 이 필요합니다: ws env drift <targetId> | --all [--project p] [--env e]");
    const t = ((await d.api("GET", `/api/env/targets?${new URLSearchParams({ id: a.targetId })}`)) as { targets: TargetInfo[] }).targets[0];
    if (!t) throw new Error(`대상 '${a.targetId}' 를 찾을 수 없습니다.`);
    targets = [t];
  }

  const failed: string[] = [];
  let issues = 0;
  for (const t of targets) {
    d.log(`대상 ${t.id} · ${t.env} → ${KIND_LABEL[t.kind]} ${t.summary}`);
    try {
      const who = await checkAccount(t, exec);
      d.log(`  계정 확인: ${who}`);
      const { results, stale, never } = await driftTarget(d, t, exec);
      const g = groupDrift(results);
      const show = (st: DriftStatus) => {
        if (st === "present" && isValueReadable(t.kind)) return;
        if ((st === "match" || st === "differs") && !isValueReadable(t.kind)) return;
        d.log(`  ${DRIFT_LABEL[st]} ${g[st].length}${st === "match" || st === "present" ? "" : `: ${g[st].join(", ") || "-"}`}`);
      };
      DRIFT_STATUSES.forEach(show);
      if (!isValueReadable(t.kind)) {
        d.log(`  (값은 읽을 수 없는 대상) 마지막 반영 이후 금고 값이 바뀜 ${stale.length}: ${stale.join(", ") || "-"} · 반영 기록 없음 ${never.length}`);
      }
      await d.api("POST", `/api/env/targets/${encodeURIComponent(t.id)}/drift`, { results });
      issues += g.differs.length + g.missing_remote.length + g.remote_only.length + (isValueReadable(t.kind) ? 0 : stale.length);
      d.log("  점검 결과를 기록했습니다(키 이름·상태만).");
    } catch (e) {
      failed.push(t.id);
      d.log(`  점검 실패: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
  }
  d.log(`점검 ${targets.length - failed.length}/${targets.length}개 대상 · 확인이 필요한 키 ${issues}개`);
  if (failed.length) throw new Error(`${failed.length}개 대상을 점검하지 못했습니다: ${failed.join(", ")}`);
}
