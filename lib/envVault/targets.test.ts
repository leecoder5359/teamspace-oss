import { describe, it, expect } from "vitest";
import { isProdTarget, looksSecret, parseTarget, syncState, targetSummary, TargetConfigError } from "./targets";
import { mergeDotenv, parseDotenv } from "./dotenv";

describe("push 대상 설정 검증", () => {
  it("종류별 모양을 받아들이고 정체 문자열을 만든다", () => {
    expect(parseTarget("dotenv", { path: "/Users/me/app/.env.local" }, {}).identity).toBe("/Users/me/app/.env.local");
    const ssm = parseTarget("ssm", { prefix: "/myapp/dev/", region: "ap-northeast-2", profile: "work" }, { accountId: "123456789012" });
    expect(ssm.config).toEqual({ prefix: "/myapp/dev", region: "ap-northeast-2", profile: "work" });
    expect(ssm.identity).toBe("ap-northeast-2:/myapp/dev");
    expect(parseTarget("vercel", { project: "web-app", target: "production", scope: "acme" }, { user: "leecoder" }).identity).toBe(
      "acme/web-app:production",
    );
    expect(parseTarget("gha", { repo: "owner/repo", environment: "prod" }, { login: "someone" }).identity).toBe("owner/repo:prod");
  });

  it("모르는 종류·모르는 필드·형식 불량은 거부(메시지에 값 없음)", () => {
    expect(() => parseTarget("s3", {}, {})).toThrow(TargetConfigError);
    expect(() => parseTarget("dotenv", { path: "/a/.env", token: "x" }, {})).toThrow(/모르는 필드: token/);
    expect(() => parseTarget("dotenv", { path: "relative/.env" }, {})).toThrow(/절대 경로/);
    expect(() => parseTarget("vercel", { project: "p", target: "staging" }, { user: "u" })).toThrow(/target/);
    expect(() => parseTarget("ssm", { prefix: "/a" }, { accountId: "12" })).toThrow(/account\.accountId/);
    expect(() => parseTarget("gha", { repo: "owner/repo" }, {})).toThrow(/account\.login/);
  });

  it("비밀처럼 보이는 문자열은 config·account 어디에도 못 넣는다", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    expect(looksSecret(secret)).toBe(true);
    expect(looksSecret("sk_live_abc")).toBe(true);
    expect(looksSecret("AKIAABCDEFGHIJKLMNOP")).toBe(true);
    expect(looksSecret("postgres://user:pass@host/db")).toBe(true);
    expect(looksSecret("a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7")).toBe(true);
    expect(looksSecret("/Users/me/dev/project/.env.local")).toBe(false);
    expect(looksSecret("/private/tmp/claude-501/547d10b7-5f78-46c9-9ab6-ce59678715a3/scratchpad/.env")).toBe(false);
    expect(looksSecret("web-app")).toBe(false);
    let err: unknown;
    try {
      parseTarget("gha", { repo: "owner/repo", environment: secret }, { login: "x" });
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toMatch(/비밀 값처럼/);
    expect((err as Error).message).not.toContain(secret);
    expect(() => parseTarget("dotenv", { path: `/tmp/${secret}` }, {})).toThrow(/비밀 값처럼/);
  });

  it("운영 판정·동기 상태·요약", () => {
    expect(isProdTarget("prod", "dotenv", {})).toBe(true);
    expect(isProdTarget("production", "gha", {})).toBe(true);
    expect(isProdTarget("dev", "vercel", { target: "production" })).toBe(true);
    expect(isProdTarget("dev", "vercel", { target: "preview" })).toBe(false);
    expect(syncState("d1", { A: "d1" }, "A")).toBe("match");
    expect(syncState("d2", { A: "d1" }, "A")).toBe("differs");
    expect(syncState("d1", null, "A")).toBe("never");
    expect(targetSummary("gha", { repo: "o/r", environment: "prod" })).toBe("o/r · env prod");
  });
});

describe("mergeDotenv", () => {
  it("주석·순서·다른 키는 그대로, 같은 키만 바꾸고 없던 키는 끝에", () => {
    const before = "# 헤더\nexport A=old\n\nKEEP=1 # 메모\nB=\"x y\"\n";
    const after = mergeDotenv(before, [{ key: "A", value: "new" }, { key: "B", value: "b b" }, { key: "C", value: "c" }]);
    expect(after).toBe("# 헤더\nexport A=new\n\nKEEP=1 # 메모\nB=\"b b\"\nC=c\n");
    expect(parseDotenv(after)).toEqual([{ key: "A", value: "new" }, { key: "KEEP", value: "1" }, { key: "B", value: "b b" }, { key: "C", value: "c" }]);
  });
  it("빈 파일·CRLF", () => {
    expect(mergeDotenv("", [{ key: "A", value: "1" }])).toBe("A=1\n");
    expect(mergeDotenv("X=1\r\nA=0\r\n", [{ key: "A", value: "2" }])).toBe("X=1\r\nA=2\r\n");
  });
});
