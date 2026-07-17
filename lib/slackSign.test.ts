import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifySlackSignature } from "@/lib/slackSign";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5"; // 슬랙 공식 문서의 예제 signing secret — gitleaks:allow

// 슬랙 문서 알고리즘으로 정답 서명을 독립 계산.
function sign(ts: number, body: string): string {
  return "v0=" + createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex");
}

describe("verifySlackSignature", () => {
  const ts = 1_700_000_000;
  const body = "token=xyz&team_id=T1&payload=%7B%7D";

  it("유효한 서명 → true", () => {
    expect(verifySlackSignature(SECRET, String(ts), body, sign(ts, body), ts)).toBe(true);
  });

  it("변조된 서명 → false", () => {
    const bad = sign(ts, body).replace(/.$/, (c) => (c === "a" ? "b" : "a"));
    expect(verifySlackSignature(SECRET, String(ts), body, bad, ts)).toBe(false);
  });

  it("본문이 다르면 → false", () => {
    expect(verifySlackSignature(SECRET, String(ts), "other=1", sign(ts, body), ts)).toBe(false);
  });

  it("timestamp 5분 초과 → false (재전송 방지)", () => {
    expect(verifySlackSignature(SECRET, String(ts), body, sign(ts, body), ts + 400)).toBe(false);
  });

  it("형식 불량/빈 서명 → false", () => {
    expect(verifySlackSignature(SECRET, String(ts), body, "", ts)).toBe(false);
    expect(verifySlackSignature(SECRET, String(ts), body, "garbage", ts)).toBe(false);
  });
});
