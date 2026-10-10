import { describe, expect, it } from "vitest";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import nextConfig from "./next.config";

describe("next.config headers()", () => {
  it("전역 규칙은 /pub 을 제외하고 보안 헤더를 단다", async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toHaveLength(1);
    const [rule] = rules;
    const keys = rule.headers.map((h) => h.key);
    for (const k of ["X-Content-Type-Options", "X-Frame-Options", "Strict-Transport-Security", "Content-Security-Policy-Report-Only"]) {
      expect(keys).toContain(k);
    }
    expect(keys).not.toContain("Content-Security-Policy");
    // Next 가 headers() source 를 매칭할 때 쓰는 것과 같은 매처·옵션(server/lib/router-utils/filesystem.js).
    const match = getPathMatch(rule.source, { strict: true, removeUnnamedParams: true });
    expect(match("/pub/tok/index.html")).toBe(false);
    for (const p of ["/", "/s/abc", "/api/tasks", "/pubx", "/p/x", "/login"]) {
      expect(match(p), p).not.toBe(false);
    }
  });
});
