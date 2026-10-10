/* env import 의 키 이름 diff (순수 — 서버 서비스와 CLI 드라이런이 같은 규칙을 쓴다). */

export type ImportMode = "merge" | "overwrite";
export type ImportDiff = { added: string[]; changed: string[]; skipped: string[] };

/** 키 이름 기준 diff. 값 비교는 하지 않는다(있음/없음). merge 는 있는 키를 건너뛰고, overwrite 는 덮어쓴다. */
export function importDiff(incoming: string[], existing: string[], mode: ImportMode): ImportDiff {
  const have = new Set(existing);
  const added: string[] = [];
  const changed: string[] = [];
  const skipped: string[] = [];
  for (const k of [...new Set(incoming)].sort()) {
    if (!have.has(k)) added.push(k);
    else if (mode === "overwrite") changed.push(k);
    else skipped.push(k);
  }
  return { added, changed, skipped };
}

export const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
