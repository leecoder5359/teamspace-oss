import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: { pairing: { findUnique: vi.fn(), update: vi.fn() } } }));
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
  it("deliverable → 200 + 토큰, update 로 전달표시", async () => {
    const code = "a".repeat(32);
    (prisma.pairing.findUnique as unknown as Mock).mockResolvedValue({
      code, token: "wst_x", userId: "u", workspaceId: "w", createdAt: new Date(), tokenDeliveredAt: null,
    });
    const res = await GET(new Request("http://t"), ctx(code));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ token: "wst_x" });
    expect(prisma.pairing.update).toHaveBeenCalled();
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
