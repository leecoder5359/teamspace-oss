import { describe, it, expect } from "vitest";
import { attachmentDisposition, siteFileHeaders, SITE_SANDBOX } from "./headers";

describe("siteFileHeaders", () => {
  const h = siteFileHeaders("text/html; charset=utf-8", 10);
  it("CSP sandbox 를 걸고 same-origin·top-navigation 은 절대 허용하지 않는다", () => {
    const csp = h["content-security-policy"];
    expect(csp).toMatch(/^sandbox /);
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).not.toContain("allow-top-navigation");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(SITE_SANDBOX).not.toContain("allow-same-origin");
  });
  it("리퍼러·스니핑·캐시 헤더", () => {
    expect(h["referrer-policy"]).toBe("no-referrer");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["cache-control"]).toBe("private, max-age=300");
    expect(h["content-length"]).toBe("10");
  });
});

describe("다운로드(?download)", () => {
  it("기본은 content-disposition 없음", () => {
    expect(siteFileHeaders("application/pdf", 1)["content-disposition"]).toBeUndefined();
  });
  it("파일명을 주면 attachment + UTF-8 파일명, sandbox CSP 는 그대로", () => {
    const h = siteFileHeaders("application/pdf", 1, "반장 포트폴리오.pdf");
    expect(h["content-disposition"]).toMatch(/^attachment; /);
    expect(h["content-disposition"]).toContain("filename*=UTF-8''%EB%B0%98");
    expect(h["content-security-policy"]).toMatch(/^sandbox /);
  });
  it("ASCII 대체 파일명에 따옴표·역슬래시·비ASCII 를 넣지 않는다", () => {
    expect(attachmentDisposition('a"b\\c.pdf')).toContain('filename="a_b_c.pdf"');
    expect(attachmentDisposition("한.pdf")).toContain('filename="_.pdf"');
  });
});
