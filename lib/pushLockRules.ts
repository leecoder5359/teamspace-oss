/**
 * 푸시·배포 잠금의 순수 규칙(DB 없음) — 서버(lib/pushLock.ts)와 CLI(scripts/wsLock.ts)가 함께 쓴다.
 * scripts/hooks/git-pre-push.mjs 에는 LOCK_NAME_RE 사본이 있다(훅은 단일 파일로 복사되므로).
 */
export const LOCK_NAME_RE = /^[a-z0-9][a-z0-9:/._-]{0,80}$/;
export const DEFAULT_TTL_MIN = 30;
export const MAX_TTL_MIN = 240;

/**
 * 잠금 이름 정규형(2026-10-10): 공백 정리·소문자, 구분자 묶음 [\s/_:.-]+ 은 "/" 하나로, 앞뒤 "/" 제거.
 * `teamspace-main`·`teamspace/main`·`TeamSpace_main`·`deploy:teamspace` → `teamspace/main`·`deploy/teamspace`.
 * 철자가 달라도 같은 자원이면 같은 잠금이어야 서로를 배제한다. 서버가 잡기·해제·조회 모두 이걸로 맞추고,
 * CLI·pre-push 훅도 같은 규칙으로 보낸다(훅에는 사본).
 */
export function canonicalLockName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s/_:.-]+/g, "/").replace(/^\/+|\/+$/g, "");
}

/** 이름 검증 — 문제가 있으면 사람이 읽을 메시지, 괜찮으면 null. */
export function lockNameError(name: unknown): string | null {
  if (typeof name !== "string" || !name) return "잠금 이름이 필요합니다.";
  if (!LOCK_NAME_RE.test(name)) return "잠금 이름은 소문자·숫자로 시작하고 소문자·숫자·: / . _ - 만, 81자 이내로 씁니다(예: banjang/develop).";
  return null;
}

/** CLI 의 --ttl 문자열(30m·2h·1h30m·45) → 분. 형식이 틀리면 null. */
export function parseTtlFlag(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?$/);
  if (!m || (!m[1] && !m[2])) return null;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}
