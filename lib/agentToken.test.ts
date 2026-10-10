import { describe, expect, it } from "vitest";
import { generateAgentToken, hashToken, isAgentTokenFormat, agentEmail, isAgentEmail } from "./agentToken";

describe("agent token", () => {
  it("generateAgentToken 은 wst_ + 64 hex 를 만든다", () => {
    const t = generateAgentToken();
    expect(t).toMatch(/^wst_[0-9a-f]{64}$/);
    expect(generateAgentToken()).not.toBe(t); // 랜덤
  });

  it("isAgentTokenFormat 은 포맷만으로 판별한다", () => {
    expect(isAgentTokenFormat(generateAgentToken())).toBe(true);
    expect(isAgentTokenFormat("wst_short")).toBe(false);
    expect(isAgentTokenFormat("not-a-token")).toBe(false);
    expect(isAgentTokenFormat("")).toBe(false);
    expect(isAgentTokenFormat(undefined)).toBe(false);
  });

  it("hashToken 은 결정적 sha256 hex", () => {
    const t = "wst_" + "a".repeat(64);
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toBe(hashToken(t + "b"));
  });

  it("agentEmail 은 토큰 id 기반 시스템 이메일을 만든다", () => {
    expect(agentEmail("abc123")).toBe("agent-abc123@agents.teamspace.local");
  });

  it("isAgentEmail 은 에이전트 시스템 이메일만 true", () => {
    expect(isAgentEmail(agentEmail("abc123"))).toBe(true);
    expect(isAgentEmail("Agent-PENDING-x@Agents.Teamspace.Local")).toBe(true);
    expect(isAgentEmail("kim@company.com")).toBe(false);
    expect(isAgentEmail(null)).toBe(false);
    expect(isAgentEmail(undefined)).toBe(false);
  });
});
