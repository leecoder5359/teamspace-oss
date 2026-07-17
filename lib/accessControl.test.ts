import { describe, it, expect } from "vitest";
import { parseAllowedDomains, emailDomainAllowed } from "@/lib/accessControl";

describe("parseAllowedDomains", () => {
  it("빈 입력은 빈 배열", () => {
    expect(parseAllowedDomains(undefined)).toEqual([]);
    expect(parseAllowedDomains(null)).toEqual([]);
    expect(parseAllowedDomains("")).toEqual([]);
    expect(parseAllowedDomains("   ")).toEqual([]);
  });

  it("콤마/공백 구분, 소문자화, 선행 @ 제거, 빈값 제거", () => {
    expect(parseAllowedDomains("example.org")).toEqual(["example.org"]);
    expect(parseAllowedDomains("A.com, @B.com  c.com")).toEqual([
      "a.com",
      "b.com",
      "c.com",
    ]);
    expect(parseAllowedDomains(" , ,@x.io, ")).toEqual(["x.io"]);
  });
});

describe("emailDomainAllowed", () => {
  const domains = ["example.org", "example.com"];

  it("허용 도메인 매칭(대소문자 무시)", () => {
    expect(emailDomainAllowed("a@example.org", domains)).toBe(true);
    expect(emailDomainAllowed("A@Example.ORG", domains)).toBe(true);
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
