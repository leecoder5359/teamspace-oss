import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { randomBytes } from "node:crypto";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    publishedSite: { findFirst: vi.fn() },
    siteIntakeEntry: { findFirst: vi.fn(), update: vi.fn(), delete: vi.fn() },
  },
}));

import { requireCtx } from "@/lib/workspace";
import { recordActivity } from "@/lib/activity";
import { prisma } from "@/lib/prisma";
import { encryptIntake, INTAKE_KEY_ENV } from "@/lib/sites/intakeCrypto";
import { GET, DELETE } from "./route";

const m = (f: unknown) => f as Mock;
const KEY = randomBytes(32).toString("base64");
const params = { params: Promise.resolve({ id: "cs1", entryId: "e1" }) };
const ctx = { workspaceId: "w1", userId: "u1", role: "admin", actor: { type: "user", id: "u1", name: "나" } };
/** AUTH_OPEN_API=true 로 세션 없이 얻은 admin (lib/workspace.resolveLegacyCtx). */
const bootstrapCtx = { workspaceId: "w1", userId: "u9", role: "admin", actor: { type: "agent", id: "u9", name: "legacy-cli" }, bootstrap: true };
const FIELDS = [{ label: "계정 이메일", value: "ops@partner.com" }, { label: "비밀번호", value: " 앞뒤공백유지 " }];
const AAD = { siteId: "cs1", submittedBy: "vendor@partner.com", service: "Supabase" };

function entry() {
  return {
    id: "e1", service: "Supabase", fieldCount: 2, secret: encryptIntake(JSON.stringify(FIELDS), AAD),
    submittedBy: "vendor@partner.com", submittedByMember: false, createdAt: new Date(), revealCount: 0,
  };
}

describe("GET/DELETE /api/sites/[id]/intake/[entryId]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv(INTAKE_KEY_ENV, KEY);
    m(prisma.siteIntakeEntry.update).mockResolvedValue({ revealCount: 1, lastRevealedAt: new Date() });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("인증·권한 실패는 그대로", async () => {
    m(requireCtx).mockResolvedValue({ err: new Response(null, { status: 403 }) });
    expect((await GET(new Request("http://t"), params)).status).toBe(403);
    expect((await DELETE(new Request("http://t"), params)).status).toBe(403);
    expect(prisma.siteIntakeEntry.findFirst).not.toHaveBeenCalled();
  });

  it("열람·삭제는 **admin** 을 요구한다 (editor 는 로그인만 하면 받는 기본 역할이다)", async () => {
    m(requireCtx).mockResolvedValue({ err: new Response(null, { status: 403 }) });
    await GET(new Request("http://t"), params);
    await DELETE(new Request("http://t"), params);
    expect(m(requireCtx).mock.calls.every((c) => c[0] === "admin")).toBe(true);
  });

  it("AUTH_OPEN_API=true 부트스트랩 admin 은 거절한다 (세션 없이 얻은 권한)", async () => {
    m(requireCtx).mockResolvedValue(bootstrapCtx);
    const g = await GET(new Request("http://t"), params);
    expect(g.status).toBe(403);
    expect((await DELETE(new Request("http://t"), params)).status).toBe(403);
    expect(prisma.publishedSite.findFirst).not.toHaveBeenCalled();
    expect(prisma.siteIntakeEntry.findFirst).not.toHaveBeenCalled();
  });

  it("복호화해 돌려주고, 열람을 기록한다 (응답은 no-store)", async () => {
    m(requireCtx).mockResolvedValue(ctx);
    m(prisma.publishedSite.findFirst).mockResolvedValue({ id: "cs1", title: "계정 이관" });
    m(prisma.siteIntakeEntry.findFirst).mockResolvedValue(entry());
    const res = await GET(new Request("http://t"), params);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.entry.fields).toEqual(FIELDS); // 앞뒤 공백이 그대로 살아 있다
    expect(body.entry.revealCount).toBe(1);
    expect(m(prisma.siteIntakeEntry.update).mock.calls[0][0]).toMatchObject({ where: { id: "e1" }, data: { revealCount: { increment: 1 } } });
    expect(recordActivity).toHaveBeenCalledWith(ctx, expect.stringContaining("열람"), "site", "계정 이관", "cs1");
  });

  // ── 스코프 고정 (I2) — 이 단언이 없으면 테넌트 경계를 지우는 변이가 초록으로 통과한다 ──
  it("엔트리 조회는 **사이트 스코프**로 한다 (남의 워크스페이스 entryId 를 못 읽는다)", async () => {
    m(requireCtx).mockResolvedValue(ctx);
    m(prisma.publishedSite.findFirst).mockResolvedValue({ id: "cs1", title: "t" });
    m(prisma.siteIntakeEntry.findFirst).mockResolvedValue(entry());
    await GET(new Request("http://t"), params);
    expect(m(prisma.siteIntakeEntry.findFirst).mock.calls[0][0]).toMatchObject({ where: { id: "e1", siteId: "cs1" } });
  });

  it("사이트 조회는 **워크스페이스 스코프**로 한다", async () => {
    m(requireCtx).mockResolvedValue(ctx);
    m(prisma.publishedSite.findFirst).mockResolvedValue({ id: "cs1", title: "t" });
    m(prisma.siteIntakeEntry.findFirst).mockResolvedValue(entry());
    await GET(new Request("http://t"), params);
    await DELETE(new Request("http://t"), params);
    for (const call of m(prisma.publishedSite.findFirst).mock.calls) {
      expect(call[0]).toMatchObject({ where: { id: "cs1", workspaceId: "w1", deletedAt: null } });
    }
  });

  it("남의 워크스페이스·없는 항목은 404", async () => {
    m(requireCtx).mockResolvedValue(ctx);
    m(prisma.publishedSite.findFirst).mockResolvedValue(null);
    expect((await GET(new Request("http://t"), params)).status).toBe(404);

    m(prisma.publishedSite.findFirst).mockResolvedValue({ id: "cs1", title: "t" });
    m(prisma.siteIntakeEntry.findFirst).mockResolvedValue(null);
    expect((await GET(new Request("http://t"), params)).status).toBe(404);
    expect(prisma.siteIntakeEntry.update).not.toHaveBeenCalled();
  });

  it("키가 바뀌었으면 409 — 열람 기록도 남기지 않고, 키·암호문을 흘리지 않는다", async () => {
    m(requireCtx).mockResolvedValue(ctx);
    m(prisma.publishedSite.findFirst).mockResolvedValue({ id: "cs1", title: "t" });
    const e = entry();
    m(prisma.siteIntakeEntry.findFirst).mockResolvedValue(e);
    vi.stubEnv(INTAKE_KEY_ENV, randomBytes(32).toString("base64"));
    const res = await GET(new Request("http://t"), params);
    expect(res.status).toBe(409);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await res.json())).not.toContain(e.secret);
    expect(prisma.siteIntakeEntry.update).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("암호문이 다른 행으로 옮겨졌으면 409 (AAD 불일치)", async () => {
    m(requireCtx).mockResolvedValue(ctx);
    m(prisma.publishedSite.findFirst).mockResolvedValue({ id: "cs1", title: "t" });
    // 다른 사이트에서 만들어진 암호문을 이 행에 붙여 넣은 상황
    const moved = { ...entry(), secret: encryptIntake(JSON.stringify(FIELDS), { ...AAD, siteId: "cs2" }) };
    m(prisma.siteIntakeEntry.findFirst).mockResolvedValue(moved);
    expect((await GET(new Request("http://t"), params)).status).toBe(409);
  });

  it("활동 로그 verb 에 게스트 자유 입력이 통째로 들어가지 않는다(줄바꿈·길이)", async () => {
    m(requireCtx).mockResolvedValue(ctx);
    m(prisma.publishedSite.findFirst).mockResolvedValue({ id: "cs1", title: "t" });
    const nasty = `줄바꿈\n위조: 관리자가 삭제함${"긴".repeat(300)}`;
    const e = { ...entry(), service: nasty, secret: encryptIntake(JSON.stringify(FIELDS), { ...AAD, service: nasty }) };
    m(prisma.siteIntakeEntry.findFirst).mockResolvedValue(e);
    await GET(new Request("http://t"), params);
    const verb = m(recordActivity).mock.calls[0][1] as string;
    expect(verb).not.toContain("\n");
    expect(verb.length).toBeLessThan(120);
  });

  it("삭제하면 활동 로그에 남는다", async () => {
    m(requireCtx).mockResolvedValue(ctx);
    m(prisma.publishedSite.findFirst).mockResolvedValue({ id: "cs1", title: "계정 이관" });
    m(prisma.siteIntakeEntry.findFirst).mockResolvedValue(entry());
    expect((await DELETE(new Request("http://t"), params)).status).toBe(200);
    expect(m(prisma.siteIntakeEntry.delete).mock.calls[0][0]).toEqual({ where: { id: "e1" } });
    expect(recordActivity).toHaveBeenCalledWith(ctx, expect.stringContaining("삭제"), "site", "계정 이관", "cs1");
  });
});
