import { describe, expect, it } from "vitest";
import { classifyEnvLoss, envKeysOf } from "./syncOssEnv.mjs";

const keys = (s: string): string[] => [...(envKeysOf(s) as Set<string>)].sort();

describe("envKeysOf", () => {
  it("process.env.X / env.X", () => {
    expect(keys("const a = process.env.FOO_BAR; const b = env.BAZ1;")).toEqual(["BAZ1", "FOO_BAR"]);
  });
  it("env[\"X\"] · env['X'] · process.env[\"X\"]", () => {
    expect(keys(`env["A_B"]; env['C']; process.env["D"]; process.env[ "E" ]`)).toEqual(["A_B", "C", "D", "E"]);
  });
  it("구조 분해: const { X, Y: y, Z = 1 } = process.env / env", () => {
    expect(keys("const { ASK_CLAUDE_MODEL, B: b, C = 'x' } = process.env;")).toEqual(["ASK_CLAUDE_MODEL", "B", "C"]);
    expect(keys("const { LOG_LEVEL } = env;")).toEqual(["LOG_LEVEL"]);
  });
  it("소문자·무관한 객체는 무시", () => {
    expect(keys("process.env.lower; const { a } = other; config.env_X;")).toEqual([]);
  });
});

describe("classifyEnvLoss", () => {
  const all = (...k: string[]) => new Set(k);
  it("OSS 가 읽는 키를 private 이 어디서도 안 읽으면 lost", () => {
    const r = classifyEnvLoss("const o = process.env.ALLOWED_DEV_ORIGINS;", "const o = 'hard-coded';", all());
    expect(r).toEqual({ lost: ["ALLOWED_DEV_ORIGINS"], relocated: [] });
  });
  it("다른 파일로 옮겨 읽으면 relocated(퇴행 아님)", () => {
    const r = classifyEnvLoss("process.env.AUTH_OPEN_API", "x", all("AUTH_OPEN_API"));
    expect(r).toEqual({ lost: [], relocated: ["AUTH_OPEN_API"] });
  });
  it("private 도 계속 읽으면 아무것도 아님", () => {
    expect(classifyEnvLoss("env.A", "env.A; env.B", all("A", "B"))).toEqual({ lost: [], relocated: [] });
  });
});
