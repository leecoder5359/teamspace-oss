import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

vi.mock("@/lib/workspace", () => ({ requireCtx: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { $queryRaw: vi.fn(async () => [1]), heartbeat: { findUnique: vi.fn(async () => ({ at: new Date() })) } },
}));
vi.mock("@/lib/aiRoutes/relay", () => ({ dayKey: () => "2026-10-09" }));
vi.mock("@/lib/aiRoutes/llmCalls", () => ({ getTeamspaceUsage: vi.fn(async () => ({ byDay: [{ day: "2026-10-09", usd: 1.5 }] })) }));
vi.mock("@/lib/llmBudget", () => ({ dailyBudgetTokens: () => 100, isExceeded: (u: number, b: number) => b > 0 && u >= b, usedTokensToday: async () => 200 }));

// 실제 파일시스템을 건드리지 않는다 — realDeps 의 fs·env·경로만 가짜로 바꾼다.
vi.mock("@/lib/opsStatus", async (orig) => {
  const actual = await orig<typeof import("@/lib/opsStatus")>();
  const old = Date.now() - 3_600_000;
  const fakeFs = {
    readdir: async (p: string) => {
      if (p === "/b") return ["20261009-110000"];
      if (p === "/b/20261009-110000") return ["teamspace.dump"];
      throw new Error("ENOENT");
    },
    stat: async () => ({ size: 2048, mtimeMs: old, isFile: () => true }),
    statfs: async () => ({ bsize: 1, blocks: 100, bavail: 50 }),
    readFile: async () => { throw new Error("ENOENT"); },
  };
  return { ...actual, realDeps: (over: Parameters<typeof actual.realDeps>[0]) => ({ ...actual.realDeps(over), fs: fakeFs, env: { TEAMSPACE_BACKUP_DIR: "/b" }, dataDir: "/data", cwd: "/app" }) };
});

import { NextResponse } from "next/server";
import { requireCtx } from "@/lib/workspace";
import { getTeamspaceUsage } from "@/lib/aiRoutes/llmCalls";
import { GET } from "./route";

const m = (f: unknown) => f as Mock;

describe("GET /api/ops/status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("admin 을 요구한다 — 아니면 requireCtx 의 거절을 그대로", async () => {
    m(requireCtx).mockResolvedValue({ err: NextResponse.json({}, { status: 403 }) });
    expect((await GET()).status).toBe(403);
    expect(requireCtx).toHaveBeenCalledWith("admin");
  });

  it("status 와 warnings 를 돌려준다", async () => {
    m(requireCtx).mockResolvedValue({ workspaceId: "w1", role: "admin", actor: { type: "user", id: "u", name: "U" } });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.status.health).toMatchObject({ db: true, worker: true });
    expect(body.status.llm).toEqual({ todayTokens: 200, todayUsd: 1.5, budgetTokens: 100, exceeded: true });
    expect(body.status.disk).toMatchObject({ path: "/data", freeRatio: 0.5 });
    expect(body.status.backup).toMatchObject({ dir: "/b", latest: "20261009-110000", sizeBytes: 2048 });
    expect(getTeamspaceUsage).toHaveBeenCalledWith("w1", 1, { purge: false }); // 읽기 전용 호출은 정리하지 않는다
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.warnings.map((w: { code: string }) => w.code)).toContain("llm_budget");
  });
});
