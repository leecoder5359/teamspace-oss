import { describe, it, expect } from "vitest";
import { isBootstrapCtx, LEGACY_ACTOR_NAME } from "./bootstrapCtx";

describe("isBootstrapCtx — AUTH_OPEN_API=true 로 세션 없이 얻은 admin 인가", () => {
  it("legacy actor 는 true", () => {
    expect(isBootstrapCtx({ actor: { type: "agent", name: LEGACY_ACTOR_NAME } })).toBe(true);
  });
  it("로그인 세션은 false", () => {
    expect(isBootstrapCtx({ actor: { type: "user", name: "나" } })).toBe(false);
    expect(isBootstrapCtx({ actor: { type: "user", name: LEGACY_ACTOR_NAME } })).toBe(false);
  });
  it("진짜 에이전트 토큰은 false (이름이 토큰 이름이다)", () => {
    expect(isBootstrapCtx({ actor: { type: "agent", name: "claude-cli" } })).toBe(false);
  });
});
