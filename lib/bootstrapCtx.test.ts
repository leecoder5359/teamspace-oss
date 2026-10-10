import { describe, it, expect } from "vitest";
import { isBootstrapCtx, isReservedAgentName, LEGACY_ACTOR_NAME } from "./bootstrapCtx";

describe("isBootstrapCtx — AUTH_OPEN_API=true 로 세션 없이 얻은 admin 인가", () => {
  it("bootstrap 플래그 ctx 는 true", () => {
    expect(isBootstrapCtx({ bootstrap: true })).toBe(true);
  });
  it("이름이 legacy-cli 인 에이전트 토큰 ctx(플래그 없음)는 false", () => {
    expect(isBootstrapCtx({ actor: { type: "agent", name: LEGACY_ACTOR_NAME } } as never)).toBe(false);
  });
  it("로그인 세션·일반 토큰은 false", () => {
    expect(isBootstrapCtx({})).toBe(false);
  });
});

describe("isReservedAgentName", () => {
  it("legacy-cli 는 공백·대소문자 무시하고 예약", () => {
    expect(isReservedAgentName("legacy-cli")).toBe(true);
    expect(isReservedAgentName("  Legacy-CLI ")).toBe(true);
  });
  it("다른 이름은 통과", () => {
    expect(isReservedAgentName("claude-cli")).toBe(false);
    expect(isReservedAgentName("legacy-cli2")).toBe(false);
  });
});
