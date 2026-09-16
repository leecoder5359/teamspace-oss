import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
  headers: vi.fn(async () => ({ get: () => null })),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findFirst: vi.fn() },
    workspace: { findFirst: vi.fn() },
    workspaceMember: { updateMany: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  },
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";

const m = (f: unknown) => f as Mock;

describe("resolveSessionCtx 자동 가입 제한", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(prisma.workspaceMember.updateMany).mockReturnValue({ catch: () => undefined });
    m(prisma.workspaceMember.findMany).mockResolvedValue([]);
    m(prisma.workspaceMember.findFirst).mockResolvedValue(null);
    m(prisma.workspace.findFirst).mockResolvedValue({ id: "w1" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("허용 도메인이 아닌 게스트는 멤버 행이 생기지 않고 403", async () => {
    vi.stubEnv("AUTH_ALLOWED_DOMAINS", "team.com");
    m(auth).mockResolvedValue({ user: { id: "u1", email: "guest@gmail.com" } });
    m(prisma.user.findFirst).mockResolvedValue({ id: "u1", name: null, email: "guest@gmail.com" });
    const r = await requireCtx("viewer");
    expect("err" in r && r.err.status).toBe(403);
    expect(prisma.workspaceMember.create).not.toHaveBeenCalled();
  });

  it("허용 도메인 사용자는 기존처럼 자동 가입", async () => {
    vi.stubEnv("AUTH_ALLOWED_DOMAINS", "team.com");
    m(auth).mockResolvedValue({ user: { id: "u2", email: "a@team.com" } });
    m(prisma.user.findFirst).mockResolvedValue({ id: "u2", name: "A", email: "a@team.com" });
    m(prisma.workspaceMember.create).mockResolvedValue({ id: "m", workspaceId: "w1", userId: "u2", role: "editor", status: "active" });
    const r = await requireCtx("viewer");
    expect("err" in r).toBe(false);
    expect(prisma.workspaceMember.create).toHaveBeenCalledTimes(1);
  });
});
