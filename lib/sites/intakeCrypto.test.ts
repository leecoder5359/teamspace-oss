import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptIntake, encryptIntake, intakeKeyError, INTAKE_KEY_ENV, type IntakeAad } from "./intakeCrypto";

const env = (v?: string) => ({ ...(v === undefined ? {} : { [INTAKE_KEY_ENV]: v }) }) as NodeJS.ProcessEnv;
const KEY = randomBytes(32).toString("base64"); // openssl rand -base64 32 와 같은 모양
const OTHER_KEY = randomBytes(32).toString("base64");
const AAD: IntakeAad = { siteId: "cs1", submittedBy: "vendor@partner.com", service: "Supabase" };

describe("intakeKeyError — 키 없으면·약하면 fail closed", () => {
  it("미설정·빈 값은 오류", () => {
    expect(intakeKeyError(env())).toContain(INTAKE_KEY_ENV);
    expect(intakeKeyError(env(""))).toContain(INTAKE_KEY_ENV);
    expect(intakeKeyError(env("   "))).toContain(INTAKE_KEY_ENV);
  });

  it("사람이 고른 문구는 거부한다(HKDF 는 스트레칭을 하지 않는다)", () => {
    // 32자를 넘겨도 base64/hex 가 아니면 거부
    expect(intakeKeyError(env("우리팀비밀번호를아주길게적어둔문구입니다정말로깁니다"))).toContain("base64");
    expect(intakeKeyError(env("correct horse battery staple correct horse"))).toContain("base64");
  });

  it("base64/hex 라도 32바이트 미만이면 거부", () => {
    expect(intakeKeyError(env(randomBytes(16).toString("base64")))).toContain("32바이트");
    expect(intakeKeyError(env(randomBytes(31).toString("hex")))).toContain("32바이트");
    expect(intakeKeyError(env("0123456789abcdef0123456789abcdef"))).toContain("32바이트"); // 32자 hex = 16바이트
  });

  it("32바이트 이상의 base64·hex 는 통과", () => {
    expect(intakeKeyError(env(KEY))).toBeNull();
    expect(intakeKeyError(env(randomBytes(32).toString("hex")))).toBeNull();
    expect(intakeKeyError(env(randomBytes(48).toString("base64url")))).toBeNull();
  });

  it("오류 문자열에 키 값이 실리지 않는다", () => {
    expect(intakeKeyError(env("shortsecret"))).not.toContain("shortsecret");
  });
});

describe("encryptIntake/decryptIntake", () => {
  it("왕복", () => {
    const plain = JSON.stringify([{ label: "비밀번호", value: "hunter2-비밀" }]);
    expect(decryptIntake(encryptIntake(plain, AAD, env(KEY)), AAD, env(KEY))).toBe(plain);
  });

  it("암호문에 평문이 들어 있지 않다", () => {
    const enc = encryptIntake("supersecret-password", AAD, env(KEY));
    expect(enc).not.toContain("supersecret-password");
    expect(Buffer.from(enc, "utf8").includes(Buffer.from("supersecret-password"))).toBe(false);
    expect(enc.startsWith("v1:")).toBe(true);
  });

  it("같은 평문도 매번 다른 암호문(IV 랜덤)", () => {
    expect(encryptIntake("x", AAD, env(KEY))).not.toBe(encryptIntake("x", AAD, env(KEY)));
  });

  it("키가 없으면 암호화·복호화 모두 throw(평문 저장 금지)", () => {
    expect(() => encryptIntake("x", AAD, env())).toThrow(INTAKE_KEY_ENV);
    const enc = encryptIntake("x", AAD, env(KEY));
    expect(() => decryptIntake(enc, AAD, env())).toThrow(INTAKE_KEY_ENV);
  });

  it("다른 키로는 못 푼다", () => {
    const enc = encryptIntake("x", AAD, env(KEY));
    expect(() => decryptIntake(enc, AAD, env(OTHER_KEY))).toThrow();
  });

  it("AAD 가 다르면 못 푼다 — 암호문을 다른 행·사이트·제출자로 옮겨 붙일 수 없다", () => {
    const enc = encryptIntake("x", AAD, env(KEY));
    expect(() => decryptIntake(enc, { ...AAD, siteId: "cs2" }, env(KEY))).toThrow();
    expect(() => decryptIntake(enc, { ...AAD, submittedBy: "attacker@evil.test" }, env(KEY))).toThrow();
    expect(() => decryptIntake(enc, { ...AAD, service: "GitHub" }, env(KEY))).toThrow();
  });

  it("변조된 암호문은 throw(GCM 태그)", () => {
    const enc = encryptIntake("hello", AAD, env(KEY));
    const [v, iv, tag, ct] = enc.split(":");
    const flipped = Buffer.from(ct, "base64");
    flipped[0] ^= 0xff;
    expect(() => decryptIntake([v, iv, tag, flipped.toString("base64")].join(":"), AAD, env(KEY))).toThrow();
  });

  it("형식이 아니면 throw", () => {
    expect(() => decryptIntake("nope", AAD, env(KEY))).toThrow();
    expect(() => decryptIntake("v2:a:b:c", AAD, env(KEY))).toThrow();
  });
});
