import { describe, it, expect, vi } from "vitest";

// 승인 카드 본문은 순수 함수 — prisma·승인 발송은 쓰지 않는다
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/approvals", () => ({ sendApproval: vi.fn() }));

import { pushCardBody } from "./push";

describe("push 승인 카드 본문 — 사람이 값이 어디로 가는지 보고 승인한다", () => {
  const keys = ["API_KEY", "DB_URL"];
  it("공통: 프로젝트·환경·종류·기대 계정·키 이름, 값 없음 안내", () => {
    const b = pushCardBody({ kind: "gha", env: "prod", config: { repo: "acme/web", environment: "production" }, account: { login: "me" } }, "반장", keys);
    expect(b).toContain("반장 / prod");
    expect(b).toContain("GitHub Actions");
    expect(b).toContain("GitHub 저장소: acme/web · environment: production");
    expect(b).toContain("GitHub me");
    expect(b).toContain("키 2개*: API_KEY, DB_URL");
    expect(b).toContain("값은 카드에 싣지 않습니다");
  });
  it("종류별 위치", () => {
    expect(pushCardBody({ kind: "ssm", env: "dev", config: { prefix: "/app/dev", region: "ap-northeast-2", profile: "work" }, account: { accountId: "123456789012" } }, "P", keys))
      .toMatch(/SSM 경로: \/app\/dev\/<KEY>[\s\S]*리전: ap-northeast-2 · 프로필: work[\s\S]*AWS 123456789012/);
    expect(pushCardBody({ kind: "vercel", env: "dev", config: { project: "web", target: "production", scope: "team", globalDir: "~/.vc" }, account: { user: "u" } }, "P", keys))
      .toMatch(/Vercel 프로젝트: web · 환경: production[\s\S]*scope: team · -Q ~\/.vc[\s\S]*Vercel u/);
    expect(pushCardBody({ kind: "dotenv", env: "local", config: { path: "/Users/me/app/.env.local" }, account: {} }, "P", keys))
      .toContain("파일: /Users/me/app/.env.local");
    expect(pushCardBody({ kind: "gha", env: "dev", config: { repo: "o/r" }, account: { login: "x" } }, "P", keys)).toContain("(저장소 secret)");
  });
});
