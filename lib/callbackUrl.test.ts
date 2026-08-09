import { describe, it, expect } from "vitest";
import { checkCallbackUrl, parseHostAllowlist } from "@/lib/callbackUrl";

const ok = (u: string, opts?: Parameters<typeof checkCallbackUrl>[1]) => checkCallbackUrl(u, opts).ok;
const why = (u: string, opts?: Parameters<typeof checkCallbackUrl>[1]) => {
  const r = checkCallbackUrl(u, opts);
  return r.ok ? "" : r.reason;
};

describe("checkCallbackUrl — 공개 대상은 통과", () => {
  it("http(s) 공개 호스트", () => {
    expect(ok("https://callback.example.com/api/feedback/callback")).toBe(true);
    expect(ok("http://example.com:8080/cb")).toBe(true);
  });
});

describe("checkCallbackUrl — 스킴·형식", () => {
  it("http(s) 가 아니면 거절", () => {
    expect(ok("file:///etc/passwd")).toBe(false);
    expect(ok("ftp://example.com/x")).toBe(false);
    expect(ok("javascript:alert(1)")).toBe(false);
    // gopher·dict 는 고전적인 SSRF 확장 스킴이다
    expect(ok("gopher://example.com/x")).toBe(false);
  });

  it("URL 이 아니면 거절", () => {
    expect(ok("not a url")).toBe(false);
    expect(ok("")).toBe(false);
  });

  it("자격증명이 박힌 URL 은 거절(프록시·게이트웨이 우회에 쓰인다)", () => {
    expect(ok("https://user:pw@example.com/cb")).toBe(false);
    expect(why("https://user:pw@example.com/cb")).toMatch(/자격증명/);
  });

  it("제어문자가 섞이면 거절", () => {
    expect(ok("https://example.com/cb\nX-Injected: 1")).toBe(false);
  });
});

describe("checkCallbackUrl — 내부 대상 차단(SSRF 핵심)", () => {
  it("루프백", () => {
    expect(ok("http://127.0.0.1:3002/admin")).toBe(false);
    expect(ok("http://127.1.2.3/x")).toBe(false);
    expect(ok("http://localhost:3002/x")).toBe(false);
    expect(ok("http://[::1]/x")).toBe(false);
    expect(ok("http://0.0.0.0/x")).toBe(false);
  });

  it("클라우드 메타데이터(169.254.169.254)", () => {
    expect(ok("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(ok("http://metadata.google.internal/computeMetadata/v1/")).toBe(false);
  });

  it("사설망 IPv4", () => {
    expect(ok("http://10.0.0.5/x")).toBe(false);
    expect(ok("http://192.168.1.1/x")).toBe(false);
    expect(ok("http://172.16.0.1/x")).toBe(false);
    expect(ok("http://172.31.255.255/x")).toBe(false);
    // 172.32 는 사설이 아니다 — 범위를 넘겨짚지 않는지 본다
    expect(ok("http://172.32.0.1/x")).toBe(true);
  });

  it("CGNAT·tailscale 대역(100.64/10)", () => {
    expect(ok("http://100.64.0.1/x")).toBe(false);
    // 100.63·100.128 은 대역 밖이다
    expect(ok("http://100.63.0.1/x")).toBe(true);
    expect(ok("http://100.128.0.1/x")).toBe(true);
  });

  it("IPv6 사설·링크로컬·매핑된 v4", () => {
    expect(ok("http://[fc00::1]/x")).toBe(false);
    expect(ok("http://[fe80::1]/x")).toBe(false);
    expect(ok("http://[::ffff:10.0.0.1]/x")).toBe(false);
    expect(ok("http://[2606:4700::1111]/x")).toBe(true);
  });

  it("내부 전용 TLD·호스트 이름", () => {
    expect(ok("http://printer.local/x")).toBe(false);
    expect(ok("http://db.internal/x")).toBe(false);
    expect(ok("http://svc.cluster.local/x")).toBe(false);
    expect(ok("http://host.localhost/x")).toBe(false);
  });

  it("8진수·16진수·정수 표기로 위장한 루프백도 막는다", () => {
    expect(ok("http://0177.0.0.1/x")).toBe(false); // 8진수 127
    expect(ok("http://2130706433/x")).toBe(false); // 127.0.0.1 정수
    expect(ok("http://0x7f000001/x")).toBe(false); // 16진수
  });

  it("allowPrivate 로 열면 통과한다(로컬 개발·테스트용)", () => {
    expect(ok("http://127.0.0.1:3002/x", { allowPrivate: true })).toBe(true);
  });
});

describe("checkCallbackUrl — 호스트 allowlist(설정하면 그것만)", () => {
  const allow = ["callback.example.com", "hooks.example.com"];

  it("목록에 있으면 통과", () => {
    expect(ok("https://callback.example.com/cb", { allowHosts: allow })).toBe(true);
    expect(ok("https://hooks.example.com/cb", { allowHosts: allow })).toBe(true);
  });

  it("서브도메인은 허용(상위 도메인을 적으면 그 아래를 신뢰한다)", () => {
    expect(ok("https://api.callback.example.com/cb", { allowHosts: allow })).toBe(true);
  });

  it("비슷하게 생긴 다른 도메인은 막는다", () => {
    expect(ok("https://callback.example.com.evil.com/cb", { allowHosts: allow })).toBe(false);
    expect(ok("https://notcallback.example.com/cb", { allowHosts: allow })).toBe(false);
    expect(why("https://evil.com/cb", { allowHosts: allow })).toMatch(/허용 목록/);
  });

  it("대소문자·후행 점을 정규화한다", () => {
    expect(ok("https://callback.example.com./cb", { allowHosts: allow })).toBe(true);
  });

  it("목록이 비어 있으면 공개 호스트는 통과(기본은 내부 차단만)", () => {
    expect(ok("https://anything.example/cb", { allowHosts: [] })).toBe(true);
  });

  it("allowlist 가 있어도 내부 대상은 여전히 막는다", () => {
    expect(ok("http://127.0.0.1/cb", { allowHosts: ["127.0.0.1"] })).toBe(false);
  });
});

describe("parseHostAllowlist", () => {
  it("콤마·공백으로 나누고 소문자화·중복제거", () => {
    expect(parseHostAllowlist(" callback.example.com , hooks.example.com,callback.example.com ")).toEqual([
      "callback.example.com",
      "hooks.example.com",
    ]);
  });

  it("URL 을 적어도 호스트만 뽑아낸다(설정 실수 흔한 형태)", () => {
    expect(parseHostAllowlist("https://callback.example.com/api/x")).toEqual(["callback.example.com"]);
  });

  it("비었거나 없으면 빈 목록", () => {
    expect(parseHostAllowlist(undefined)).toEqual([]);
    expect(parseHostAllowlist("")).toEqual([]);
    expect(parseHostAllowlist(" , ")).toEqual([]);
  });
});
