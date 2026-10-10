import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { changelogEntry: { findFirst: vi.fn(), update: vi.fn(), deleteMany: vi.fn() } },
}));
vi.mock("@/lib/pageGuard", () => ({ loadAccess: vi.fn(), projectAccess: vi.fn() }));
vi.mock("@/lib/projectRef", () => ({ resolveProjectRef: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { requireCtx } from "@/lib/workspace";
import { loadAccess, projectAccess } from "@/lib/pageGuard";
import { resolveProjectRef } from "@/lib/projectRef";
import { PATCH, DELETE } from "./route";

const m = (f: unknown) => f as Mock;
const ctx = { workspaceId: "w1", userId: "u1", role: "editor", actor: { type: "user", id: "u1", name: "U" } };
const params = { params: Promise.resolve({ id: "e1" }) };
const patch = (b: unknown) => new Request("http://t/api/changelog/e1", { method: "PATCH", body: JSON.stringify(b), headers: { "content-type": "application/json" } });
const del = () => new Request("http://t/api/changelog/e1", { method: "DELETE" });

describe("/api/changelog/[id] 프로젝트 접근(D3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m(requireCtx).mockResolvedValue(ctx);
    m(loadAccess).mockResolvedValue({});
    m(projectAccess).mockImplementation((_i: unknown, p: string) => (p === "pSecret" ? "none" : p === "pView" ? "view" : "edit"));
    m(prisma.changelogEntry.findFirst).mockResolvedValue({ id: "e1", projectId: "pOpen" });
  });

  it("PATCH 숨겨진 프로젝트의 항목 → 404, 수정 안 함", async () => {
    m(prisma.changelogEntry.findFirst).mockResolvedValue({ id: "e1", projectId: "pSecret" });
    expect((await PATCH(patch({ title: "x" }), params)).status).toBe(404);
    expect(prisma.changelogEntry.update).not.toHaveBeenCalled();
  });

  it("DELETE 숨겨진 프로젝트의 항목 → 404, 삭제 안 함", async () => {
    m(prisma.changelogEntry.findFirst).mockResolvedValue({ projectId: "pSecret" });
    expect((await DELETE(del(), params)).status).toBe(404);
    expect(prisma.changelogEntry.deleteMany).not.toHaveBeenCalled();
  });

  it("보기 전용 프로젝트 — 항목 PATCH/DELETE 404, 그 프로젝트로 옮기기 400", async () => {
    m(prisma.changelogEntry.findFirst).mockResolvedValue({ id: "e1", projectId: "pView" });
    expect((await PATCH(patch({ title: "x" }), params)).status).toBe(404);
    expect((await DELETE(del(), params)).status).toBe(404);
    m(prisma.changelogEntry.findFirst).mockResolvedValue({ id: "e1", projectId: "pOpen" });
    m(resolveProjectRef).mockResolvedValue({ ok: true, projectId: "pView" });
    expect((await PATCH(patch({ projectId: "pView" }), params)).status).toBe(400);
    expect(prisma.changelogEntry.update).not.toHaveBeenCalled();
    expect(prisma.changelogEntry.deleteMany).not.toHaveBeenCalled();
  });

  it("DELETE 보이는/공용 항목 → 삭제", async () => {
    m(prisma.changelogEntry.findFirst).mockResolvedValue({ projectId: null });
    expect((await DELETE(del(), params)).status).toBe(200);
    expect(prisma.changelogEntry.deleteMany).toHaveBeenCalledWith({ where: { id: "e1", workspaceId: "w1" } });
  });

  it("PATCH projectId 설정 → resolveProjectRef 결과 저장", async () => {
    m(resolveProjectRef).mockResolvedValue({ ok: true, projectId: "pOpen" });
    expect((await PATCH(patch({ projectId: "pOpen" }), params)).status).toBe(200);
    expect(resolveProjectRef).toHaveBeenCalledWith("pOpen", "w1");
    expect(m(prisma.changelogEntry.update).mock.calls[0][0].data.projectId).toBe("pOpen");
  });

  it('PATCH projectId "" → 공용(null)으로 해제', async () => {
    m(resolveProjectRef).mockResolvedValue({ ok: true, projectId: null });
    expect((await PATCH(patch({ projectId: "" }), params)).status).toBe(200);
    expect(m(prisma.changelogEntry.update).mock.calls[0][0].data).toHaveProperty("projectId", null);
  });

  it("PATCH projectId 생략 → 프로젝트는 건드리지 않음", async () => {
    await PATCH(patch({ title: "새 제목" }), params);
    expect(m(prisma.changelogEntry.update).mock.calls[0][0].data).not.toHaveProperty("projectId");
  });

  it("PATCH 다른 워크스페이스 프로젝트 id → 400", async () => {
    m(resolveProjectRef).mockResolvedValue({ ok: false, err: NextResponse.json({ error: "x" }, { status: 400 }) });
    expect((await PATCH(patch({ projectId: "foreign" }), params)).status).toBe(400);
    expect(prisma.changelogEntry.update).not.toHaveBeenCalled();
  });

  it("PATCH 볼 수 없는 프로젝트로 옮기기 → 400", async () => {
    m(resolveProjectRef).mockResolvedValue({ ok: true, projectId: "pSecret" });
    expect((await PATCH(patch({ projectId: "pSecret" }), params)).status).toBe(400);
    expect(prisma.changelogEntry.update).not.toHaveBeenCalled();
  });
});
