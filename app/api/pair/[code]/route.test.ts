import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: { pairing: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() } } }));
import { prisma } from "@/lib/prisma";
import { GET } from "./route";

const ctx = (code: string) => ({ params: Promise.resolve({ code }) });
// clearAllMocks 는 호출 이력만 지우고 mockResolvedValue(구현)는 남겨 이전 테스트의 반환값이
// 다음 테스트로 새는 문제(예: 마지막 테스트가 이전 delivered row 를 그대로 받음)가 있어 resetAllMocks 사용.
beforeEach(() => vi.resetAllMocks());

describe("GET /api/pair/[code]", () => {
  it("행 없음 → 202 pending", async () => {
    (prisma.pairing.findUnique as unknown as Mock).mockResolvedValue(null);
    const res = await GET(new Request("http://t"), ctx("a".repeat(32)));
    expect(res.status).toBe(202);
  });
  it("deliverable → 200 + 토큰, 조건부 update 로 전달표시", async () => {
    const code = "a".repeat(32);
    (prisma.pairing.findUnique as unknown as Mock).mockResolvedValue({
      code, token: "wst_x", userId: "u", workspaceId: "w", createdAt: new Date(), tokenDeliveredAt: null,
    });
    (prisma.pairing.updateMany as unknown as Mock).mockResolvedValue({ count: 1 });
    const res = await GET(new Request("http://t"), ctx(code));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ token: "wst_x" });
    // 인도는 "미전달·같은 토큰·미만료" 조건이 붙은 update 여야 한다(읽고-쓰기 금지)
    const where = (prisma.pairing.updateMany as unknown as Mock).mock.calls[0][0].where;
    expect(where).toMatchObject({ code, tokenDeliveredAt: null, token: "wst_x" });
    expect(where.createdAt.gt).toBeInstanceOf(Date);
  });

  it("경합에서 져 0행이면 토큰을 주지 않는다 — 다른 폴이 받아갔으면 410 delivered", async () => {
    const code = "a".repeat(32);
    const row = { code, token: "wst_x", userId: "u", workspaceId: "w", createdAt: new Date(), tokenDeliveredAt: null };
    (prisma.pairing.findUnique as unknown as Mock)
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce({ ...row, tokenDeliveredAt: new Date() });
    (prisma.pairing.updateMany as unknown as Mock).mockResolvedValue({ count: 0 });
    const res = await GET(new Request("http://t"), ctx(code));
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ status: "delivered" });
  });

  it("재승인이 끼어들어 토큰이 갈렸으면 410 이 아니라 202 — 설치를 죽이지 않는다", async () => {
    const code = "a".repeat(32);
    const row = { code, token: "wst_old", userId: "u", workspaceId: "w", createdAt: new Date(), tokenDeliveredAt: null };
    (prisma.pairing.findUnique as unknown as Mock)
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce({ ...row, token: "wst_new" });
    (prisma.pairing.updateMany as unknown as Mock).mockResolvedValue({ count: 0 });
    const res = await GET(new Request("http://t"), ctx(code));
    expect(res.status).toBe(202);
  });
  it("이미 전달 → 410", async () => {
    const code = "a".repeat(32);
    (prisma.pairing.findUnique as unknown as Mock).mockResolvedValue({
      code, token: "wst_x", userId: "u", workspaceId: "w", createdAt: new Date(), tokenDeliveredAt: new Date(),
    });
    const res = await GET(new Request("http://t"), ctx(code));
    expect(res.status).toBe(410);
  });
  it("code 형식오류 → 400", async () => {
    const res = await GET(new Request("http://t"), ctx("bad"));
    expect(res.status).toBe(400);
  });
});
