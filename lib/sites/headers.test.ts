import { describe, it, expect } from "vitest";
import { siteFileHeaders, SITE_SANDBOX } from "./headers";

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
