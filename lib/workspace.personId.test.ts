import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn(async () => null) }));
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

import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { viewerPersonId } from "@/lib/viewerPerson";

const m = (f: unknown) => f as Mock;
const TOKEN = `wst_${"a".repeat(64)}`;

/* 개인 레슨의 기준이 되는 '요청의 사람' — 에이전트 토큰은 발급자(AgentToken.issuedById). */
describe("requireCtx — personId", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(headers).mockResolvedValue(new Headers({ "x-ws-token": TOKEN }));
    m(prisma.agentToken.update).mockReturnValue({ catch: () => undefined });
  });

  it("에이전트 토큰 → personId = issuedById", async () => {
    m(prisma.agentToken.findUnique).mockResolvedValue({ id: "t1", workspaceId: "w1", userId: "agentU", name: "mac", role: "editor", revokedAt: null, issuedById: "human1" });
    const ctx = await requireCtx("viewer");
    expect(ctx).toMatchObject({ userId: "agentU", actor: { type: "agent" }, personId: "human1" });
    expect(viewerPersonId(ctx as never)).toBe("human1");
  });

  it("발급자 미상 토큰 → personId = null (개인 레슨 없이 동작)", async () => {
    m(prisma.agentToken.findUnique).mockResolvedValue({ id: "t1", workspaceId: "w1", userId: "agentU", name: "mac", role: "editor", revokedAt: null, issuedById: null });
    const ctx = await requireCtx("viewer");
    expect(viewerPersonId(ctx as never)).toBeNull();
  });
});

describe("viewerPersonId", () => {
  it("personId 가 있으면 그대로, 없으면 사람=userId · 에이전트=null", () => {
    expect(viewerPersonId({ userId: "u", personId: "p" })).toBe("p");
    expect(viewerPersonId({ userId: "u", personId: null })).toBeNull();
    expect(viewerPersonId({ userId: "u" })).toBe("u");
    expect(viewerPersonId({ userId: "u", actor: { type: "user" } })).toBe("u");
    expect(viewerPersonId({ userId: "ag", actor: { type: "agent" } })).toBeNull();
  });
});
