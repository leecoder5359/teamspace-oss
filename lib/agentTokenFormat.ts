/* 에이전트 토큰 형식 검사 — node:crypto 없는 엣지 안전 모듈(middleware·lib/rateLimit 에서 import).
 * 포맷: `wst_<64 hex>` (발급은 lib/agentToken.ts).
 * 클라이언트 컴포넌트(멤버 화면 → lib/membersSplit)도 이 모듈만 import 한다 — agentToken 을 끌어오면
 * crypto-browserify 폴리필(~430KB)이 초기 JS 에 실린다. */
const TOKEN_RE = /^wst_[0-9a-f]{64}$/;

export function isAgentTokenFormat(token: string | null | undefined): boolean {
  return typeof token === "string" && TOKEN_RE.test(token);
}

export const AGENT_EMAIL_SUFFIX = "@agents.teamspace.local";

/** 에이전트 토큰의 시스템 User 이메일인지(pending 포함) 판별. */
export function isAgentEmail(email: string | null | undefined): boolean {
  return typeof email === "string" && email.toLowerCase().endsWith(AGENT_EMAIL_SUFFIX);
}
