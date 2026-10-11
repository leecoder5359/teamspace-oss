import { afterEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "./url";

describe("siteUrl — 공유 링크는 /pages/<slug>", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("PUBLIC_BASE_URL 이 있으면 그 위에(끝 슬래시 정리)", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://ts.example.com/");
    expect(siteUrl(new Request("http://localhost:3000/api/sites"), "banjang-handover")).toBe("https://ts.example.com/pages/banjang-handover");
  });

  it("없으면 프록시 헤더 → 요청 origin", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "");
    const proxied = new Request("http://localhost:3000/api/sites", { headers: { "x-forwarded-host": "ts.example.net", "x-forwarded-proto": "https" } });
    expect(siteUrl(proxied, "MEzDPE2vDpXH")).toBe("https://ts.example.net/pages/MEzDPE2vDpXH");
    expect(siteUrl(new Request("http://localhost:3000/api/sites"), "abc")).toBe("http://localhost:3000/pages/abc");
  });
});
