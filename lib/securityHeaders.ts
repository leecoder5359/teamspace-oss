/* 전역 보안 헤더 — next.config.ts 와 테스트가 함께 쓰는 순수 모듈(부수효과·import 없음).
   CSP 는 **Report-Only 만** 낸다. 위반 로그로 허용 목록을 다듬은 뒤 2단계에서 enforce 한다.
   /pub/* 는 라우트가 자체 sandbox CSP 를 내므로 next.config 에서 이 규칙을 제외한다. */

export const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  // 위반 수집: 구형 report-uri + Reporting API(report-to ↔ Reporting-Endpoints 헤더). app/api/csp-report/route.ts
  "report-uri /api/csp-report",
  "report-to csp-endpoint",
].join("; ");

export function securityHeaders(opts: { reportOnly: boolean }): { key: string; value: string }[] {
  const headers = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    // /s/<slug> 셸이 같은 출처의 /pub iframe 을 품는다 — SAMEORIGIN 이면 통과.
    { key: "X-Frame-Options", value: "SAMEORIGIN" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    // HTTP 로컬에서는 브라우저가 무시한다.
    { key: "Strict-Transport-Security", value: "max-age=15552000; includeSubDomains" },
  ];
  // enforce 모드는 2단계 몫 — 지금은 Report-Only 키만 지원한다.
  if (opts.reportOnly) headers.push({ key: "Reporting-Endpoints", value: 'csp-endpoint="/api/csp-report"' });
  if (opts.reportOnly) headers.push({ key: "Content-Security-Policy-Report-Only", value: CSP_REPORT_ONLY });
  return headers;
}
