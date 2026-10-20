import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AGENT_EMAIL_SUFFIX } from "./agentTokenFormat";

/**
 * 에이전트 토큰 유틸 (W1).
 * 토큰 포맷: `wst_<64 hex>` — 발급 시 1회만 노출하고 DB에는 sha256 해시만 저장한다.
 */

export { isAgentTokenFormat, isAgentEmail } from "./agentTokenFormat";

export function generateAgentToken(): string {
  return `wst_${randomBytes(32).toString("hex")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 에이전트 시스템 User 의 이메일 (토큰과 1:1). */
export function agentEmail(tokenId: string): string {
  return `agent-${tokenId}${AGENT_EMAIL_SUFFIX}`;
}

/** 레거시 공유 토큰 비교 (timing-safe). */
export function tokenEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
