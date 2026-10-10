import { ENV_KEY_RE } from "./diff";

/* =====================================================================
   env 금고 P3a — 드리프트(금고 ↔ 원격) 비교. 순수 함수(CLI 와 서버가 같은 규칙을 쓴다).

   - 비교는 CLI 가 메모리에서 한다. 서버에는 **키 → 상태** 만 보낸다(값·해시 없음).
   - 값을 읽을 수 있는 대상(.env 파일·SSM): match · differs · missing_remote · remote_only
   - 이름만 읽을 수 있는 대상(Vercel sensitive·GHA secret): present · missing_remote · remote_only
     ("마지막 반영 이후 금고 값이 바뀌었나" 는 P2 지문 비교(sync 상태)로 따로 보인다)
   ===================================================================== */

export const DRIFT_STATUSES = ["match", "differs", "missing_remote", "remote_only", "present"] as const;
export type DriftStatus = (typeof DRIFT_STATUSES)[number];
export type DriftResults = Record<string, DriftStatus>;

/** 값까지 읽을 수 있는 대상 종류. */
export const VALUE_READABLE_KINDS = ["dotenv", "ssm"] as const;
export const isValueReadable = (kind: string) => (VALUE_READABLE_KINDS as readonly string[]).includes(kind);

export const MAX_DRIFT_KEYS = 1000;

export const DRIFT_LABEL: Record<DriftStatus, string> = {
  match: "일치",
  differs: "다름",
  missing_remote: "원격 없음",
  remote_only: "원격에만",
  present: "원격에 있음",
};

type Pair = { key: string; value: string };

/** 값 비교(.env 파일·SSM). 원격의 키 이름 형식이 아닌 항목은 무시한다. */
export function compareValues(vault: Pair[], remote: Pair[]): DriftResults {
  const r = new Map<string, string>();
  for (const p of remote) if (ENV_KEY_RE.test(p.key)) r.set(p.key, p.value); // 같은 키가 두 번이면 마지막 값(dotenv 로더와 같은 규칙)
  const out: DriftResults = {};
  const vaultKeys = new Set<string>();
  for (const v of vault) {
    vaultKeys.add(v.key);
    out[v.key] = !r.has(v.key) ? "missing_remote" : r.get(v.key) === v.value ? "match" : "differs";
  }
  for (const k of r.keys()) if (!vaultKeys.has(k)) out[k] = "remote_only";
  return sortResults(out);
}

/** 이름만 비교(Vercel·GHA). */
export function compareNames(vaultKeys: string[], remote: Iterable<string>): DriftResults {
  const r = new Set([...remote].filter((k) => ENV_KEY_RE.test(k)));
  const out: DriftResults = {};
  for (const k of vaultKeys) out[k] = r.has(k) ? "present" : "missing_remote";
  for (const k of r) if (!(k in out)) out[k] = "remote_only";
  return sortResults(out);
}

function sortResults(r: DriftResults): DriftResults {
  return Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** 상태별 키 이름 묶음. */
export function groupDrift(r: DriftResults): Record<DriftStatus, string[]> {
  const g = Object.fromEntries(DRIFT_STATUSES.map((s) => [s, [] as string[]])) as Record<DriftStatus, string[]>;
  for (const [k, s] of Object.entries(r)) g[s]?.push(k);
  return g;
}

export class DriftInputError extends Error {}

/**
 * 서버 측 검증 — 상태 enum·키 형식·대상 종류와 상태의 짝·금고 키와의 정합.
 * 메시지에는 키 이름만 넣는다(키는 비밀이 아니다).
 */
export function validateDriftResults(input: unknown, kind: string, vaultKeys: Iterable<string>): DriftResults {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new DriftInputError("results 는 {KEY: 상태} 객체여야 합니다.");
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_DRIFT_KEYS) throw new DriftInputError(`한 번에 ${MAX_DRIFT_KEYS}개 키까지만 기록할 수 있습니다.`);
  const readable = isValueReadable(kind);
  const allowed = new Set<string>(readable ? ["match", "differs", "missing_remote", "remote_only"] : ["present", "missing_remote", "remote_only"]);
  const vault = new Set(vaultKeys);
  const out: DriftResults = {};
  for (const [key, st] of entries) {
    if (!ENV_KEY_RE.test(key)) throw new DriftInputError(`키 이름 형식이 올바르지 않습니다: ${key.slice(0, 80)}`);
    if (typeof st !== "string" || !allowed.has(st)) {
      throw new DriftInputError(`${key}: 상태는 ${[...allowed].join("·")} 중 하나여야 합니다.`);
    }
    const inVault = vault.has(key);
    if (st === "remote_only" && inVault) throw new DriftInputError(`${key}: 금고에 있는 키는 remote_only 일 수 없습니다.`);
    if (st !== "remote_only" && !inVault) throw new DriftInputError(`${key}: 금고에 없는 키입니다(remote_only 만 가능).`);
    out[key] = st as DriftStatus;
  }
  return sortResults(out);
}

/** 저장된 lastDrift(JSON) → 결과 맵. 모르는 상태는 버린다. */
export function driftMap(v: unknown): DriftResults {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const ok = new Set<string>(DRIFT_STATUSES);
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).filter((e): e is [string, DriftStatus] => typeof e[1] === "string" && ok.has(e[1])),
  );
}

/** "다름" 으로 셀 상태 — 값이 다르거나 원격에 빠졌거나 원격에만 있는 것. */
export function driftIssueCount(r: DriftResults): number {
  return Object.values(r).filter((s) => s === "differs" || s === "missing_remote" || s === "remote_only").length;
}
