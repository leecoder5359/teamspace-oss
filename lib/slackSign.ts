import { createHmac, timingSafeEqual } from "node:crypto";

// 슬랙 요청 서명 검증(HMAC-SHA256, v0 스킴).
// https://api.slack.com/authentication/verifying-requests-from-slack
const MAX_SKEW_SEC = 300;

/**
 * @param secret  슬랙 앱 Signing Secret (AUTH_SLACK_SIGNING_SECRET)
 * @param timestamp  X-Slack-Request-Timestamp 헤더 값
 * @param rawBody  요청 원문(파싱 전 raw string)
 * @param signature  X-Slack-Signature 헤더 값 ("v0=...")
 * @param nowSec  현재 시각(초) — 테스트 주입용. 기본 Date.now()/1000.
 */
export function verifySlackSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!secret || !timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > MAX_SKEW_SEC) return false;

  const expected = "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
