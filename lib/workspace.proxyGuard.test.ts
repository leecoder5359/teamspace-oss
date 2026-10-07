import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
  headers: vi.fn(async () => new Headers()),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findFirst: vi.fn(), upsert: vi.fn() },
    workspace: { findFirst: vi.fn(), findUnique: vi.fn() },
    workspaceMember: { updateMany: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    agentToken: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

import { auth } from "@/auth";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import {
  PROXY_MEMBER_HEADER,
  PROXY_SIG_HEADER,
  PROXY_SITE_HEADER,
  PROXY_VIEWER_HEADER,
} from "@/lib/sites/proxyIdentity";

const m = (f: unknown) => f as Mock;
const withHeaders = (h: Record<string, string>) => m(headers).mockResolvedValue(new Headers(h));

/**
 * C1 인터록의 **동작** 테스트.
 *
 * /pub 프록시는 초대 게스트의 `fetch('api/…')` 를 upstream 으로 넘긴다. 그 upstream 이 앱
 * 자신이면 게스트 요청이 우리 /api/* 로 들어오고, `AUTH_OPEN_API=true` 면 거기서 세션 없이
 * admin 이 나갔다(저장된 자격 증명이 게스트에게 그대로 읽혔다).
 *
 * requireCtx 는 프록시가 붙인 헤더를 보고 **세션 해석 전에** 끊는다. 프록시는 그 헤더를 항상
 * 붙이고 게스트는 지울 수 없으므로(원 요청에서 content-type·accept 만 통과) 우회가 없다.
 */
describe("requireCtx — /pub 프록시 경유 요청 차단 (C1 인터록)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(prisma.workspaceMember.updateMany).mockReturnValue({ catch: () => undefined });
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["서명 헤더만", { [PROXY_SIG_HEADER]: "1.abc" }],
    ["사이트 id 헤더만", { [PROXY_SITE_HEADER]: "cs1" }],
    ["열람자 헤더만", { [PROXY_VIEWER_HEADER]: "guest@gmail.com" }],
    ["멤버 헤더만", { [PROXY_MEMBER_HEADER]: "true" }],
    ["네 개 전부", {
      [PROXY_SITE_HEADER]: "cs1",
      [PROXY_VIEWER_HEADER]: "guest@gmail.com",
      [PROXY_MEMBER_HEADER]: "false",
      [PROXY_SIG_HEADER]: "1.abc",
    }],
  ])("%s 붙어 있어도 403 — 하나만 있어도 막는다(OR)", async (_label, h) => {
    withHeaders(h);
    const r = await requireCtx("viewer");
    expect("err" in r && r.err.status).toBe(403);
  });

  it("차단은 세션 해석보다 **먼저** — auth() 도 DB 도 건드리지 않는다", async () => {
    withHeaders({ [PROXY_SIG_HEADER]: "1.abc" });
    const r = await requireCtx("viewer");
    expect("err" in r).toBe(true);
    expect(auth).not.toHaveBeenCalled();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.workspace.findFirst).not.toHaveBeenCalled();
    expect(prisma.workspaceMember.findMany).not.toHaveBeenCalled();
  });

  it("AUTH_OPEN_API=true 여도 부트스트랩 admin 으로 내려가지 않는다", async () => {
    vi.stubEnv("AUTH_OPEN_API", "true");
    withHeaders({ [PROXY_SITE_HEADER]: "cs1" });
    const r = await requireCtx("admin");
    expect("err" in r && r.err.status).toBe(403);
    expect(prisma.user.upsert).not.toHaveBeenCalled();
    expect(prisma.workspace.findFirst).not.toHaveBeenCalled();
  });

  it("에이전트 토큰을 같이 붙여도 뚫리지 않는다", async () => {
    withHeaders({ [PROXY_SIG_HEADER]: "1.abc", "x-ws-token": "wst_deadbeef" });
    const r = await requireCtx("admin");
    expect("err" in r && r.err.status).toBe(403);
    expect(prisma.agentToken.findUnique).not.toHaveBeenCalled();
  });

  it("프록시 헤더가 없는 평소 요청은 그대로 진행한다(차단이 전면적이지 않다)", async () => {
    withHeaders({ "content-type": "application/json" });
    m(auth).mockResolvedValue(null);
    const r = await requireCtx("viewer");
    // 세션도 토큰도 없으니 401 — 403(프록시 차단)이 아니다.
    expect("err" in r && r.err.status).toBe(401);
    expect(auth).toHaveBeenCalled();
  });

  it("헤더 이름 대소문자는 상관없다(HTTP 헤더는 대소문자 무시)", async () => {
    withHeaders({ "X-TeamSpace-Site-Id": "cs1" });
    const r = await requireCtx("viewer");
    expect("err" in r && r.err.status).toBe(403);
  });
});
