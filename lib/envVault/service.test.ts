import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";

// 기본 테스트 스위트용(실DB 없이) — 입력 검증·감사 정책. 실제 쓰기 경로는 service.db.test.ts 가 본다.
vi.mock("@/lib/approvals", () => ({ sendApproval: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findFirst: vi.fn() },
    envVar: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    envAccessLog: { create: vi.fn() },
    envOp: { create: vi.fn() },
    envTarget: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

import { prisma } from "@/lib/prisma";
import { checkValue, listVars, requestImport, setVar } from "./service";

const m = (f: unknown) => f as Mock;
const ctx = { workspaceId: "w1", userId: "u1", actor: { type: "user" as const, id: "u1", name: "U" } };
const meta = { viaFunnel: false };

describe("env 금고 서비스 — 입력 검증·감사 정책", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    m(prisma.project.findFirst).mockResolvedValue({ id: "p1", name: "P" });
    m(prisma.envVar.findMany).mockResolvedValue([]);
    m(prisma.user.findMany).mockResolvedValue([]);
    m(prisma.envTarget.findMany).mockResolvedValue([]);
  });

  it("빈 값은 400 '값을 입력해 주세요.'", async () => {
    expect(() => checkValue("", "K")).toThrow("값을 입력해 주세요.");
    await expect(setVar(ctx, { projectId: "p1", env: "dev", key: "K", value: "" }, meta)).rejects.toMatchObject({ status: 400, message: "값을 입력해 주세요." });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.envAccessLog.create).not.toHaveBeenCalled();
  });

  it("import 에 빈 값 키가 있으면 400 + 키 이름 목록, 대기 작업을 만들지 않는다", async () => {
    await expect(
      requestImport(ctx, { projectId: "p1", env: "dev", vars: [{ key: "B", value: "" }, { key: "OK", value: "x" }, { key: "A", value: "" }] }, meta),
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/B, A/) });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.envOp.create).not.toHaveBeenCalled();
  });

  it("목록 조회는 감사 로그를 남기지 않는다", async () => {
    await listVars(ctx, { projectId: "p1", env: "dev" });
    expect(prisma.envAccessLog.create).not.toHaveBeenCalled();
  });
});
