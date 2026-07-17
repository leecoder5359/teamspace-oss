import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
import { requireCtx } from "@/lib/workspace";
import { POST } from "./route";

function req(body: unknown) {
  return new Request("http://t/api/pair/approve", { method: "POST", body: JSON.stringify(body) });
}
beforeEach(() => vi.clearAllMocks());

describe("POST /api/pair/approve", () => {
  it("미로그인 → requireCtx 의 401 그대로", async () => {
    (requireCtx as unknown as Mock).mockResolvedValue({ err: new Response("no", { status: 401 }) });
    const res = await POST(req({ code: "a".repeat(32) }));
    expect(res.status).toBe(401);
  });
  it("code 없으면 400", async () => {
    (requireCtx as unknown as Mock).mockResolvedValue({ workspaceId: "w", userId: "u", role: "editor" });
    const res = await POST(req({}));
    expect(res.status).toBe(400);
  });
  it("code 형식 오류(32hex 아님) → 400", async () => {
    (requireCtx as unknown as Mock).mockResolvedValue({ workspaceId: "w", userId: "u", role: "editor" });
    const res = await POST(req({ code: "xyz" }));
    expect(res.status).toBe(400);
  });
  it("requireCtx 를 admin 게이트로 호출한다 (새 머신 프로비저닝 = admin 액션)", async () => {
    (requireCtx as unknown as Mock).mockResolvedValue({ err: new Response("no", { status: 403 }) });
    await POST(req({ code: "a".repeat(32) }));
    expect(requireCtx).toHaveBeenCalledWith("admin");
  });
});
