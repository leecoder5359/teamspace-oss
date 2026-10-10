import { describe, it, expect } from "vitest";
import { accountSection, buildAccountLines, shortenHome, ACCOUNT_CHARS_MAX } from "./sessionAccounts";

const ssm = (prefix: string, accountId: string, profile?: string) => ({ kind: "ssm", config: { prefix, ...(profile ? { profile } : {}) }, account: { accountId } });

describe("buildAccountLines", () => {
  it("대상이 없으면 빈 배열, 섹션도 빈 배열(출력 불변)", () => {
    expect(buildAccountLines([])).toEqual([]);
    expect(accountSection([])).toEqual([]);
  });

  it("같은 종류는 한 줄로 묶고 계정·프로필·경로를 중복 제거한다", () => {
    const lines = buildAccountLines([ssm("/acme/dev", "123456789012", "acme"), ssm("/acme/prod", "123456789012", "acme")]);
    expect(lines).toEqual(["- AWS: 계정 123456789012 · 프로필 acme (SSM /acme/dev·/acme/prod)"]);
  });

  it("종류 순서는 aws > vercel > gha > dotenv, 최대 3줄(dotenv 가 먼저 빠진다)", () => {
    const lines = buildAccountLines([
      { kind: "dotenv", config: { path: "/Users/me/x/.env" }, account: {} },
      { kind: "gha", config: { repo: "o/r" }, account: { login: "me" } },
      { kind: "vercel", config: { project: "web", target: "production", scope: "team-a" }, account: { user: "u1" } },
      ssm("/a", "111111111111"),
    ], { home: "/Users/me" });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^- AWS: 계정 111111111111 \(SSM \/a\)$/);
    expect(lines[1]).toBe("- Vercel: u1 · scope team-a (프로젝트 web)");
    expect(lines[2]).toBe("- GitHub: me (gh 는 GITHUB_TOKEN 을 비우고: env -u GITHUB_TOKEN gh …)");
  });

  it("경로의 $HOME 을 ~ 로 줄인다(vercel -Q · dotenv)", () => {
    const lines = buildAccountLines([
      { kind: "vercel", config: { project: "teamspace", target: "production", globalDir: "/Users/me/.vercel-alt" }, account: { user: "leecoder5359" } },
      { kind: "dotenv", config: { path: "/Users/me/dev/a/.env" }, account: {} },
    ], { home: "/Users/me/" });
    expect(lines).toEqual([
      "- Vercel: leecoder5359 · -Q ~/.vercel-alt (프로젝트 teamspace)",
      "- 로컬 .env: ~/dev/a/.env (계정 확인 없음)",
    ]);
    expect(shortenHome("/Users/mex/a", "/Users/me")).toBe("/Users/mex/a");
    expect(shortenHome("/Users/me", "/Users/me")).toBe("~");
    expect(shortenHome("/x", null)).toBe("/x");
  });

  it("값이 많으면 '외 N' 으로 접고, 합계는 300자를 넘지 않는다", () => {
    const many = Array.from({ length: 10 }, (_, i) => ssm(`/very/long/prefix/number/${i}/${"x".repeat(30)}`, `${i}`.repeat(12), `profile-${i}`));
    const lines = buildAccountLines([
      ...many,
      ...Array.from({ length: 6 }, (_, i) => ({ kind: "vercel", config: { project: `p${i}`.repeat(10), target: "preview", scope: `s${i}`.repeat(10) }, account: { user: `user${i}`.repeat(8) } })),
      { kind: "gha", config: { repo: "o/r" }, account: { login: "me" } },
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("외 7");
    expect(lines.join("\n").length).toBeLessThanOrEqual(ACCOUNT_CHARS_MAX);
    expect(lines.every((l) => l.startsWith("- "))).toBe(true);
    expect(lines[0].endsWith("…")).toBe(true);
  });

  it("maxLines=1 은 가장 중요한 종류 한 줄", () => {
    const lines = buildAccountLines([{ kind: "gha", config: { repo: "o/r" }, account: { login: "me" } }, ssm("/a", "111111111111")], { maxLines: 1 });
    expect(lines).toEqual(["- AWS: 계정 111111111111 (SSM /a)"]);
  });

  it("계정이 비었거나 모르는 종류·깨진 config 는 안전하게 다룬다", () => {
    expect(buildAccountLines([{ kind: "ssm", config: { prefix: "/a" }, account: {} }])).toEqual(["- AWS: 계정 미지정 (SSM /a)"]);
    expect(buildAccountLines([{ kind: "weird", config: null, account: null }])).toEqual([]);
    expect(buildAccountLines([{ kind: "dotenv", config: "x", account: null }])).toEqual([]);
  });

  it("섹션은 제목 + 줄 + 빈 줄", () => {
    expect(accountSection(["- a"])).toEqual(["## 계정 (env 금고 반영 대상)", "- a", ""]);
  });
});
