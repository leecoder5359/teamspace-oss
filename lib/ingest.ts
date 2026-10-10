import { createHmac, timingSafeEqual } from "node:crypto";

/* agentmemory → /api/ingest 인입 헬퍼. 순수 로직(HMAC 검증 + cwd→WS 매핑). */

/** HMAC-SHA256(hex) 서명 검증. timing-safe. */
export function verifyHmac(secret: string, rawBody: string, signatureHex: string): boolean {
  if (!secret || !signatureHex) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHex);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type RouteRule = { cwdPrefix: string; workspaceId: string; priority: number };
export type RouteRuleFull = RouteRule & { projectId: string | null };

/**
 * cwd → 라우트룰 전체(workspaceId + projectId). 매칭 규칙은 resolveWorkspaceByCwd 와 동일:
 * priority 높은 것 우선, 동률이면 더 긴(구체적) 접두사. 없으면 null.
 */
export function resolveRouteByCwd<T extends RouteRule>(
  cwd: string | null | undefined,
  rules: readonly T[],
): T | null {
  if (!cwd) return null;
  const matches = rules.filter((r) => cwd.startsWith(r.cwdPrefix));
  if (matches.length === 0) return null;
  matches.sort((x, y) => y.priority - x.priority || y.cwdPrefix.length - x.cwdPrefix.length);
  return matches[0];
}

/**
 * cwd → workspaceId. cwd 가 cwdPrefix 로 시작하는 규칙 중
 * 우선순위(priority) 높은 것, 동률이면 더 긴(구체적) 접두사 우선. 없으면 null.
 */
export function resolveWorkspaceByCwd(cwd: string | null | undefined, rules: readonly RouteRule[]): string | null {
  if (!cwd) return null;
  const matches = rules.filter((r) => cwd.startsWith(r.cwdPrefix));
  if (matches.length === 0) return null;
  matches.sort((x, y) => y.priority - x.priority || y.cwdPrefix.length - x.cwdPrefix.length);
  return matches[0].workspaceId;
}
