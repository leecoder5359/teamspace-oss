import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// realDeps 의 fs·env 는 가짜로 바꾸지 않는다 — 임시 폴더의 실제 파일을 읽는다. (DB·인증·AI 사용량만 모의)
vi.mock("@/lib/workspace", () => ({
  requireCtx: vi.fn(async () => ({ workspaceId: "w1", role: "admin", actor: { type: "user", id: "u", name: "U" } })),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $queryRaw: vi.fn(async () => [1]), heartbeat: { findUnique: vi.fn(async () => ({ at: new Date() })) } },
}));
vi.mock("@/lib/aiRoutes/relay", () => ({ dayKey: () => "2026-10-09" }));
vi.mock("@/lib/aiRoutes/llmCalls", () => ({ getTeamspaceUsage: vi.fn(async () => ({ byDay: [] })) }));
vi.mock("@/lib/llmBudget", () => ({ dailyBudgetTokens: () => 0, isExceeded: () => false, usedTokensToday: async () => 0 }));

import { GET } from "./route";

describe("GET /api/ops/status — realDeps 실제 배선", () => {
  let tmp: string;
  let prev: string | undefined;
  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "ops-backup-"));
    prev = process.env.TEAMSPACE_BACKUP_DIR;
    process.env.TEAMSPACE_BACKUP_DIR = tmp;
    const name = "20200101-030000";
    const dir = path.join(tmp, name);
    mkdirSync(dir);
    writeFileSync(path.join(dir, "teamspace.dump"), "x".repeat(2000));
    writeFileSync(path.join(dir, "docs.tar.gz"), "y".repeat(20));
    const old = new Date(Date.now() - 3_600_000);
    for (const f of ["teamspace.dump", "docs.tar.gz"]) utimesSync(path.join(dir, f), old, old);
    // 실패한 더 새 시도(덤프 없음)는 이 테스트의 관심사가 아니므로 만들지 않는다.
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.TEAMSPACE_BACKUP_DIR;
    else process.env.TEAMSPACE_BACKUP_DIR = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("임시 폴더의 완성 백업을 그대로 보고한다", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status.backup).toMatchObject({ dir: tmp, latest: "20200101-030000", sizeBytes: 2020 });
    expect(body.status.backup.inProgress).toBeUndefined();
    expect(body.status.backup.ageHours).toBeGreaterThan(72);
    expect(body.warnings.map((w: { code: string }) => w.code)).toContain("backup_stale");
  });
});
