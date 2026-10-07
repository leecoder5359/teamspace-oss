import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { randomBytes } from "node:crypto";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { publishedSite: { findFirst: vi.fn() }, siteIntakeEntry: { findMany: vi.fn() } },
}));

import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { INTAKE_KEY_ENV } from "@/lib/sites/intakeCrypto";
import { GET } from "./route";

const m = (f: unknown) => f as Mock;
const params = { params: Promise.resolve({ id: "cs1" }) };
const ctx = { workspaceId: "w1", userId: "u1", role: "viewer", actor: { type: "user", id: "u1", name: "나" } };
const bootstrapCtx = { workspaceId: "w1", userId: "u9", role: "admin", actor: { type: "agent", id: "u9", name: "legacy-cli" } };

describe("GET /api/sites/[id]/intake — 멤버용 목록", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv(INTAKE_KEY_ENV, randomBytes(32).toString("base64"));
  });
  afterEach(() => vi.unstubAllEnvs());

  it("인증 실패는 그대로 (게스트는 여기 닿지 못한다)", async () => {
    m(requireCtx).mockResolvedValue({ err: new Response(null, { status: 401 }) });
    expect((await GET(new Request("http://t"), params)).status).toBe(401);
    expect(prisma.siteIntakeEntry.findMany).not.toHaveBeenCalled();
  });

  it("AUTH_OPEN_API=true 부트스트랩 admin 은 거절한다", async () => {
    m(requireCtx).mockResolvedValue(bootstrapCtx);
    expect((await GET(new Request("http://t"), params)).status).toBe(403);
    expect(prisma.publishedSite.findFirst).not.toHaveBeenCalled();
    expect(prisma.siteIntakeEntry.findMany).not.toHaveBeenCalled();
  });

  it("남의 워크스페이스 사이트는 404", async () => {
    m(requireCtx).mockResolvedValue(ctx);
    m(prisma.publishedSite.findFirst).mockResolvedValue(null);
    expect((await GET(new Request("http://t"), params)).status).toBe(404);
    expect(m(prisma.publishedSite.findFirst).mock.calls[0][0]).toMatchObject({ where: { id: "cs1", workspaceId: "w1", deletedAt: null } });
    expect(prisma.siteIntakeEntry.findMany).not.toHaveBeenCalled();
  });

  it("목록에는 값도 암호문도 없고, 그 사이트로 스코프된다", async () => {
    m(requireCtx).mockResolvedValue(ctx);
    m(prisma.publishedSite.findFirst).mockResolvedValue({ id: "cs1" });
    m(prisma.siteIntakeEntry.findMany).mockResolvedValue([
      { id: "e1", service: "Supabase", fieldCount: 3, submittedBy: "vendor@partner.com", submittedByMember: false, createdAt: new Date(), revealCount: 0, lastRevealedAt: null },
    ]);
    const res = await GET(new Request("http://t"), params);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.entries[0]).toMatchObject({ id: "e1", service: "Supabase", submittedBy: "vendor@partner.com" });
    expect(body.entries[0].secret).toBeUndefined();
    expect(body.keyMissing).toBe(false);

    const call = m(prisma.siteIntakeEntry.findMany).mock.calls[0][0];
    // select 절에 secret 이 없어야 한다(실수로 실려 나가지 않게)
    expect(call.select.secret).toBeUndefined();
    // 사이트 스코프 — 빼면 전 워크스페이스의 인테이크 메타데이터가 한 화면에 쏟아진다(I2)
    expect(call).toMatchObject({ where: { siteId: "cs1" } });
  });

  it("키가 없으면 keyMissing 으로 알린다", async () => {
    vi.stubEnv(INTAKE_KEY_ENV, "");
    m(requireCtx).mockResolvedValue(ctx);
    m(prisma.publishedSite.findFirst).mockResolvedValue({ id: "cs1" });
    m(prisma.siteIntakeEntry.findMany).mockResolvedValue([]);
    const body = await (await GET(new Request("http://t"), params)).json();
    expect(body.keyMissing).toBe(true);
  });
});
