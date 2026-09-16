import { describe, it, expect, afterEach, vi } from "vitest";
import {
  parseAllowedDomains,
  emailDomainAllowed,
  canAutoJoinDefaultWorkspace,
  isVerifiedOAuthEmail,
} from "@/lib/accessControl";

describe("parseAllowedDomains", () => {
  it("빈 입력은 빈 배열", () => {
    expect(parseAllowedDomains(undefined)).toEqual([]);
    expect(parseAllowedDomains(null)).toEqual([]);
    expect(parseAllowedDomains("")).toEqual([]);
    expect(parseAllowedDomains("   ")).toEqual([]);
  });

  it("콤마/공백 구분, 소문자화, 선행 @ 제거, 빈값 제거", () => {
    expect(parseAllowedDomains("example.com")).toEqual(["example.com"]);
    expect(parseAllowedDomains("A.com, @B.com  c.com")).toEqual([
      "a.com",
      "b.com",
      "c.com",
    ]);
    expect(parseAllowedDomains(" , ,@x.io, ")).toEqual(["x.io"]);
  });
});

describe("emailDomainAllowed", () => {
  const domains = ["example.com", "example.com"];

  it("허용 도메인 매칭(대소문자 무시)", () => {
    expect(emailDomainAllowed("a@example.com", domains)).toBe(true);
    expect(emailDomainAllowed("A@example.com", domains)).toBe(true);
    expect(emailDomainAllowed("b@example.com", domains)).toBe(true);
  });

  it("미허용 도메인/잘못된 이메일/빈 목록은 false", () => {
    expect(emailDomainAllowed("a@gmail.com", domains)).toBe(false);
    expect(emailDomainAllowed("noatsign", domains)).toBe(false);
    expect(emailDomainAllowed("", domains)).toBe(false);
    expect(emailDomainAllowed(null, domains)).toBe(false);
    expect(emailDomainAllowed("a@example.com", [])).toBe(false);
  });

  it("서브도메인은 정확히 일치할 때만(부분일치 금지)", () => {
    expect(emailDomainAllowed("a@mail.example.com", domains)).toBe(false);
    expect(emailDomainAllowed("a@example.com.evil.com", domains)).toBe(false);
  });
});

describe("canAutoJoinDefaultWorkspace", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("허용 도메인이 없으면 누구도 자동 가입하지 않는다(초대 전용 모드)", () => {
    vi.stubEnv("AUTH_ALLOWED_DOMAINS", "");
    expect(canAutoJoinDefaultWorkspace("guest@gmail.com")).toBe(false);
  });

  it("허용 도메인 이메일만 자동 가입한다", () => {
    vi.stubEnv("AUTH_ALLOWED_DOMAINS", "team.com");
    expect(canAutoJoinDefaultWorkspace("a@team.com")).toBe(true);
    expect(canAutoJoinDefaultWorkspace("A@Team.com")).toBe(true);
    expect(canAutoJoinDefaultWorkspace("guest@gmail.com")).toBe(false);
    expect(canAutoJoinDefaultWorkspace(null)).toBe(false);
  });
});

describe("isVerifiedOAuthEmail", () => {
  it("Google 은 email_verified 가 true 일 때만 통과(계정 자동 연결의 전제)", () => {
    expect(isVerifiedOAuthEmail("google", { email_verified: true })).toBe(true);
    expect(isVerifiedOAuthEmail("google", { email_verified: false })).toBe(false);
    expect(isVerifiedOAuthEmail("google", {})).toBe(false);
    expect(isVerifiedOAuthEmail("google", undefined)).toBe(false);
  });
  it("Google 이 아닌 경로(자격증명 없음)는 이 검사 대상이 아니다", () => {
    expect(isVerifiedOAuthEmail(undefined, undefined)).toBe(true);
  });
});
