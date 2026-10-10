import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/pageGuard", async () => {
  const { NextResponse } = await import("next/server");
  return {
    loadAccess: vi.fn(async () => ({})),
    gatePage: vi.fn(),
    notFound: () => NextResponse.json({ error: "페이지를 찾을 수 없습니다." }, { status: 404 }),
  };
});
vi.mock("@/lib/graphLoad", () => ({ invalidateGraphCache: vi.fn() }));
vi.mock("@/lib/activity", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { page: { findFirst: vi.fn(), update: vi.fn() } } }));

import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { gatePage } from "@/lib/pageGuard";
import { invalidateGraphCache } from "@/lib/graphLoad";
import { recordActivity } from "@/lib/activity";
import { prisma } from "@/lib/prisma";
import { POST } from "./route";

const m = (f: unknown) => f as Mock;
const ctx = { workspaceId: "w1", userId: "u1", role: "editor", actor: { type: "user", id: "u1", name: "U" } };
const post = (b: unknown) => new Request("http://t/api/pages/archive", { method: "POST", body: JSON.stringify(b) });
const at = new Date("2026-10-01T00:00:00.000Z");

describe("POST /api/pages/archive", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue(ctx);
    m(gatePage).mockReturnValue({ idx: {}, level: "edit" });
    m(prisma.page.findFirst).mockResolvedValue({ id: "p1", title: "문서", archivedAt: null, updatedAt: at });
    m(prisma.page.update).mockImplementation(async ({ data }: { data: { archivedAt: Date | null } }) => ({ archivedAt: data.archivedAt }));
  });

  it("editor 이상을 요구한다", async () => {
    m(requireCtx).mockResolvedValue({ err: NextResponse.json({}, { status: 403 }) });
    expect((await POST(post({ id: "p1", archived: true }))).status).toBe(403);
    expect(requireCtx).toHaveBeenCalledWith("editor");
    expect(prisma.page.update).not.toHaveBeenCalled();
  });

  it("본문 검증: id·archived(boolean) 필수 → 400", async () => {
    expect((await POST(post({ id: "p1" }))).status).toBe(400);
    expect((await POST(post({ id: "p1", archived: "yes" }))).status).toBe(400);
  });

  it("볼 수 없는 페이지는 게이트의 404 그대로 — 쓰기 없음", async () => {
    m(gatePage).mockReturnValue({ err: NextResponse.json({}, { status: 404 }) });
    expect((await POST(post({ id: "p1", archived: true }))).status).toBe(404);
    expect(gatePage).toHaveBeenCalledWith({}, "p1", "edit");
    expect(prisma.page.update).not.toHaveBeenCalled();
  });

  it("삭제됐거나 다른 워크스페이스 페이지는 404", async () => {
    m(prisma.page.findFirst).mockResolvedValue(null);
    expect((await POST(post({ id: "p1", archived: true }))).status).toBe(404);
    expect(m(prisma.page.findFirst).mock.calls[0][0].where).toMatchObject({ id: "p1", workspaceId: "w1", deletedAt: null });
  });

  it("보관: archivedAt 설정·updatedAt 보존·활동 archived", async () => {
    const res = await POST(post({ id: "p1", archived: true }));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ changed: true, page: { id: "p1", archived: true } });
    expect(j.page.archivedAt).toEqual(expect.any(String));
    const data = m(prisma.page.update).mock.calls[0][0].data;
    expect(data.archivedAt).toBeInstanceOf(Date);
    expect(data.updatedAt).toBe(at);
    expect(recordActivity).toHaveBeenCalledWith(ctx, "archived", "page", "문서", "p1");
    expect(invalidateGraphCache).toHaveBeenCalledWith("w1");
  });

  it("해제: archivedAt null·활동 unarchived", async () => {
    m(prisma.page.findFirst).mockResolvedValue({ id: "p1", title: "문서", archivedAt: at, updatedAt: at });
    const j = await (await POST(post({ id: "p1", archived: false }))).json();
    expect(j).toMatchObject({ changed: true, page: { archived: false, archivedAt: null } });
    expect(m(prisma.page.update).mock.calls[0][0].data.archivedAt).toBeNull();
    expect(recordActivity).toHaveBeenCalledWith(ctx, "unarchived", "page", "문서", "p1");
  });

  it("이미 그 상태면 쓰지 않는다(시각·활동 중복 방지)", async () => {
    const j = await (await POST(post({ id: "p1", archived: false }))).json();
    expect(j.changed).toBe(false);
    expect(prisma.page.update).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
    expect(invalidateGraphCache).not.toHaveBeenCalled();
  });
});
