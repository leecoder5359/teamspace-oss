/* 에이전트 토큰 형식 검사 — node:crypto 없는 엣지 안전 모듈(middleware·lib/rateLimit 에서 import).
 * 포맷: `wst_<64 hex>` (발급은 lib/agentToken.ts). */
const TOKEN_RE = /^wst_[0-9a-f]{64}$/;

export function isAgentTokenFormat(token: string | null | undefined): boolean {
  return typeof token === "string" && TOKEN_RE.test(token);
}
