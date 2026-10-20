import { describe, it, expect } from "vitest";
import { poolConfigFromEnv } from "./prismaPool";

describe("poolConfigFromEnv (감사 P-13)", () => {
  it("풀 env 가 없으면 연결 문자열만 — pg 기본값 그대로", () => {
    expect(poolConfigFromEnv({ DATABASE_URL: "postgres://x" })).toEqual({ connectionString: "postgres://x" });
  });

  it("DATABASE_POOL_MAX·DATABASE_POOL_IDLE_MS 가 있으면 max·idleTimeoutMillis 로", () => {
    expect(poolConfigFromEnv({ DATABASE_URL: "postgres://x", DATABASE_POOL_MAX: "20", DATABASE_POOL_IDLE_MS: "30000" }))
      .toEqual({ connectionString: "postgres://x", max: 20, idleTimeoutMillis: 30000 });
  });

  it("idle 0 은 pg 의미(자동 해제 끔) 그대로 넘긴다", () => {
    expect(poolConfigFromEnv({ DATABASE_POOL_IDLE_MS: "0" })).toEqual({ connectionString: undefined, idleTimeoutMillis: 0 });
  });

  it("숫자가 아니거나 범위 밖이면 무시한다(잘못된 설정으로 풀을 깨지 않게)", () => {
    for (const bad of ["", "abc", "-1", "1.5", "0x10"]) {
      expect(poolConfigFromEnv({ DATABASE_POOL_MAX: bad, DATABASE_POOL_IDLE_MS: bad === "" ? "" : `${bad}` })).toEqual({ connectionString: undefined });
    }
    expect(poolConfigFromEnv({ DATABASE_POOL_MAX: "0" })).toEqual({ connectionString: undefined }); // max 0 은 의미 없음
  });
});
