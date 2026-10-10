import { describe, expect, it } from "vitest";
import { CSP_REPORT_ONLY, securityHeaders } from "./securityHeaders";

const get = (h: { key: string; value: string }[], k: string) => h.find((x) => x.key === k)?.value;

describe("securityHeaders", () => {
  it("기본 5종 헤더 값", () => {
    const h = securityHeaders({ reportOnly: true });
    expect(get(h, "X-Content-Type-Options")).toBe("nosniff");
    expect(get(h, "X-Frame-Options")).toBe("SAMEORIGIN");
    expect(get(h, "Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(get(h, "Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
    expect(get(h, "Strict-Transport-Security")).toBe("max-age=15552000; includeSubDomains");
  });
  it("CSP 는 Report-Only 키로만 나간다", () => {
    const h = securityHeaders({ reportOnly: true });
    expect(get(h, "Content-Security-Policy-Report-Only")).toBe(CSP_REPORT_ONLY);
    expect(get(h, "Content-Security-Policy")).toBeUndefined();
  });
  it("reportOnly=false 여도 enforce CSP 는 내지 않는다", () => {
    const h = securityHeaders({ reportOnly: false });
    expect(get(h, "Content-Security-Policy")).toBeUndefined();
    expect(get(h, "Content-Security-Policy-Report-Only")).toBeUndefined();
  });
  it("CSP 지시어: frame-ancestors self, 폰트 호스트", () => {
    expect(CSP_REPORT_ONLY).toContain("frame-ancestors 'self'");
    expect(CSP_REPORT_ONLY).toContain("default-src 'self'");
    expect(CSP_REPORT_ONLY).toContain("https://fonts.gstatic.com");
  });
  it("위반 수집: report-uri + report-to, Reporting-Endpoints 헤더가 같은 엔드포인트를 가리킨다", () => {
    expect(CSP_REPORT_ONLY).toContain("report-uri /api/csp-report");
    expect(CSP_REPORT_ONLY).toContain("report-to csp-endpoint");
    expect(get(securityHeaders({ reportOnly: true }), "Reporting-Endpoints")).toBe('csp-endpoint="/api/csp-report"');
    expect(get(securityHeaders({ reportOnly: false }), "Reporting-Endpoints")).toBeUndefined();
  });
});
