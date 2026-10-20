import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/graphLoad", () => ({ invalidateGraphCache: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { decision: { findFirst: vi.fn() } } }));

import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { prisma } from "@/lib/prisma";
import { GET } from "./route";

/* 단건 읽기 — 문서 허브 딥링크(/docs?cat=decisions&id=)가 목록(최신 200건·프로젝트 필터) 밖의 결정도 열게. */
const m = (f: unknown) => f as Mock;
const get = (id: string) => GET(new Request(`http://t/api/decisions/${id}`), { params: Promise.resolve({ id }) });
const dec = { id: "x1", title: "인증은 Auth.js", context: null, decision: null, status: "accepted", decidedAt: "2026-10-01T00:00:00.000Z", project: { name: "P", color: "blue" } };

describe("GET /api/decisions/[id]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", userId: "u1", role: "viewer" });
  });

  it("목록 항목과 같은 모양(project 포함)으로 이 워크스페이스의 결정 하나를 준다", async () => {
    m(prisma.decision.findFirst).mockResolvedValue(dec);
    const res = await get("x1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ decision: dec });
    expect(prisma.decision.findFirst).toHaveBeenCalledWith({
      where: { id: "x1", workspaceId: "w1" },
      include: { project: { select: { name: true, color: true } } },
    });
    expect(requireCtx).toHaveBeenCalledWith(); // 목록 GET 과 같은 권한(viewer 이상)
  });

  it("없거나 다른 워크스페이스의 결정은 404", async () => {
    m(prisma.decision.findFirst).mockResolvedValue(null);
    expect((await get("nope")).status).toBe(404);
  });

  it("인증 실패는 가드 응답 그대로", async () => {
    m(requireCtx).mockResolvedValue({ err: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) });
    expect((await get("x1")).status).toBe(401);
    expect(prisma.decision.findFirst).not.toHaveBeenCalled();
  });
});
