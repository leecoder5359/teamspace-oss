import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { openValue, sealValue, valueDigest, varAad, vaultEnabled, vaultKey } from "./crypto";

const KEY = randomBytes(32).toString("base64");

describe("env 금고 암호화", () => {
  const prev = process.env.ENV_VAULT_KEY;
  beforeEach(() => {
    process.env.ENV_VAULT_KEY = KEY;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.ENV_VAULT_KEY;
    else process.env.ENV_VAULT_KEY = prev;
  });

  it("봉인 → 열기 왕복, 형식은 v1:iv:tag:ct 이고 평문이 보이지 않는다", () => {
    const aad = varAad("w1", "p1", "dev", "API_KEY");
    const sealed = sealValue("s3cr3t-값", aad);
    expect(sealed.split(":")).toHaveLength(4);
    expect(sealed.startsWith("v1:")).toBe(true);
    expect(sealed).not.toContain("s3cr3t");
    expect(openValue(sealed, aad)).toBe("s3cr3t-값");
  });

  it("같은 값도 매번 다른 암호문(IV 무작위)", () => {
    const aad = varAad("w1", "p1", "dev", "K");
    expect(sealValue("x", aad)).not.toBe(sealValue("x", aad));
  });

  it("AAD(좌표)가 바뀌면 열리지 않고, 에러에 평문이 없다", () => {
    const sealed = sealValue("top-secret", varAad("w1", "p1", "dev", "K"));
    let msg = "";
    try {
      openValue(sealed, varAad("w1", "p1", "prod", "K"));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toBe("");
    expect(msg).not.toContain("top-secret");
  });

  it("변조된 암호문은 거부", () => {
    const aad = varAad("w1", "p1", "dev", "K");
    const [v, iv, tag, ct] = sealValue("hello", aad).split(":");
    const flipped = Buffer.from(ct, "base64");
    flipped[0] ^= 0xff;
    expect(() => openValue([v, iv, tag, flipped.toString("base64")].join(":"), aad)).toThrow();
  });

  it("다른 키로는 열리지 않는다", () => {
    const aad = varAad("w1", "p1", "dev", "K");
    const sealed = sealValue("hello", aad);
    process.env.ENV_VAULT_KEY = randomBytes(32).toString("base64");
    expect(() => openValue(sealed, aad)).toThrow();
  });

  it("키가 없으면 비활성, 봉인 시도는 throw", () => {
    delete process.env.ENV_VAULT_KEY;
    expect(vaultKey()).toBeNull();
    expect(vaultEnabled()).toBe(false);
    expect(() => sealValue("x", "a")).toThrow(/ENV_VAULT_KEY/);
  });

  it("잘못된 키 길이·형식은 거부(비활성)", () => {
    process.env.ENV_VAULT_KEY = randomBytes(16).toString("base64");
    expect(vaultKey()).toBeNull();
    process.env.ENV_VAULT_KEY = "not base64 !!";
    expect(vaultKey()).toBeNull();
  });

  it("valueDigest 는 결정적이고 키에 묶인다", () => {
    const a = valueDigest("v");
    expect(valueDigest("v")).toBe(a);
    expect(valueDigest("w")).not.toBe(a);
    process.env.ENV_VAULT_KEY = randomBytes(32).toString("base64");
    expect(valueDigest("v")).not.toBe(a);
  });
});
